/**
 *
 *      ioBroker fritzbox Adapter
 *
 *      (c) 2015 Michael Herwig <ruhr@digheim.de>
 *
 *      MIT License
 *
 *
 *    Callmonitor an der Fritzbox einschalten:
 *    Wenn man beim Telefon #96*5* eintippt, wird der TCP-Port 1012 geoffnet.
 *    Mit #96*4* wird dieser wieder geschlossen.
 *
 *    Format der Fritzbox-Meldungen:
 *
 *    Ausgehende Anrufe:            datum;CALL;      CallID;Nebenstelle;callingNumber;calledNumber;lineType;
 *    Eingehende Anrufe:            datum;RING;      CallID;callingNumber;calledNumber;lineTpe;
 *    Zustandegekommene Verbindung: datum;CONNECT;   CallID;Nebenstelle;connectedNumber;
 *    Ende der Verbindung:          datum;DISCONNECT;CallID;dauerInSekunden;
 *
 */

// TODO Wie können auf der Adminseite die Werte vor Änderung (onChange) kontrolliert und ggf. markiert werden?
// TODO Leistungsmerkmale: (2) Fritzbox Telefonbuch importieren und verarbeiten
// TODO Anruferlisten persistent realisieren (nicht die erstellten Tabellen, sonder die die Arrays mit den Listeneinträgen (historyListAllHtml, historyListAllTxt, historyListAllJson, historyListMissedHtml)
//      -> ggf. Redesign. Nicht verschiedene Listen, sondern eine JSON und die Funktionen so ändern, dass makeList auf diese eine JSON aufbaut

"use strict";   // verlangt saubereren Code (nach ECMAScript 5) - EMPFEHLUNG:  beim Programmieren rein, im fertigen Programm raus

// require() ist eine Funktion von node.js, um weitere Module nachzuladen

var utils = require('@iobroker/adapter-core'); // Get common adapter utils
var xml2js = require('xml2js'); // node-Modul um xml Strukturen in JSON umzuwandeln. Eine Beschreibung: http://www.flyacts.com/blog/nodejs-xml-daten-verarbeiten/
                                // Bei der Entwicklung ins iobroker.frittbox Verzeichnis installieren. Als Admin, d.h. beim Mac mit sudo:
                                // sudo npm install xml2js --save
                                // mit dem --save wird es ins packet.json geschrieben
                                // vorbereitet, um das Telefonbuch der Fritzbox zu verarbeiten (Export im XML Format)
var net =    require('net');    // node-Modul für die tcp/ip Kommunikation
                                // ist schon in node.js enthalten
                                // Beschreibung: https://nodejs.org/api/net.html
var tr = require("tr-064");     // node-Modul für die Kommunikation via TR-064 mit der FritzBox
                                // Beschreibung zu TR-064: http://avm.de/service/schnittstellen/

var request = require("request");
var https = require("https");

const { existsSync, writeFile, mkdirSync } = require('fs');
const path = require('path');

var adapter = utils.Adapter('fritzbox');

var call = [];

// Werte werden über die Adminseite gesetzt
var // adapter.config.fritzboxAddress // ip-Adresse der Fritzbox
    configCC                    = "",   // eigene Landesvorwahl ohne führende 0
    configAC                    = "",   // eigene Ortsvorwahl ohne führende 0
    configUnknownNumber         = "",   // "### ? ###"wie soll eine unbekannte/unterdrückte externe Rufnummer angezeigt werden
    configNumberLength          = 15,   // (df=15) max. Stellen externer Rufnummern, die in den Tabellen HTML und TXT angezeigt werden
    configExternalLink          = true, // externe Rufnummer als wählbaren Link (tel:)
    configShowHeadline          = true, // Anruferliste mit überschrift?
    showHistoryAllTableTxt      = true,
    showHistoryAllTableHTML     = true,
    showHistoryAllTableJSON     = true,
    showCallmonitor             = true,
    showMissedTableHTML         = true,
    showMissedTableJSON         = true;

// restlichen Config Werte
var ipCallgen                   = "172.16.130.122",     // ip-Adresse des Callgenerators, wenn vorhanden
    configDeltaTimeOKSec        = 5,                    // Abweichung in Sekunden zwischen der Systemzeit von ioBroker und der Meldungszeit aus der Fritzbox, die noch als OK gilt
    configInit                  = true,                 // true = alle Werte werden zurückgesetzt, false = Werte aus den ioBroker Objekten werden eingelesen
    configHistoryAllLines       = 12,                   // Anzahl der Einträge in der Anruferliste gesamt
    configHistoryMissedLines    = 10;                   // Anzahl der Einträge in der Anruferliste verpasste Anrufe



var ringLastNumber             = "",
    ringLastNumberTel          = "",
    ringLastMissedNumber       = "",
    ringLastMissedNumberTel    = "",
//    ringActualNumber           = "",
//    ring                       = false,
    callLastNumber             = "",
    callLastNumberTel          = "",
//    connectNumber              = "",
    missedCount                = 0,
    historyListAllHtml         = [],
    historyListAllTxt          = [],
    historyListAllJson         = [],
    historyListMissedHtml      = [];


var objMissedCount = 0;

var onlyOne         = false; // Flag, ob main() schon einmal durchgeführt wurde

var headlineDate            = "Tag    Zeit  ",  // mit utf-8 nbsp
    headlineExtnumber       = "ext. Rufnr.",
    headlineDirection       = "g<>k",
    headlineExtension       = "Nbst",
    headlineOwnnumber       = "Eigenes Amt",
    headlineLine            = "Ltg.",
    headlineDuration        = "  Dauer",        // mit utf-8 nbsp
    nbsp                    = " ",              // utf-8 nbsp
    headlineTableAllTxt     = "",
    headlineTableAllHTML    = "",
    headlineTableMissedHTML = "";



// Liste der aktiven RINGs, CALLs, CONNECTs
var listRing            = [],
    listCall            = [],
    listConnect         = [],
    listAll             = [];

// für den 1-Sekundentimer für den Callmonitor
var intervalRunningCall = null;

// für die TR-064-Abfragen
var intervalTR046 = null;
var wlanState = null;



adapter.on('message', function (obj) {
//    if (obj) processMessage(obj);
//    processMessages();
    adapter.log.debug('adapter.on-message: << MESSAGE >>');
});

// hier startet der Adapter
adapter.on('ready', function () {
    adapter.log.debug('adapter.on-ready: << READY >>');
    main();
});

// hier wird der Adapter beendet
adapter.on('unload', function () {
    adapter.log.debug('adapter.on-unload: << UNLOAD >>');
    clearRealtimeVars();

    if (intervalRunningCall) {
        clearInterval(intervalRunningCall);
        intervalRunningCall = null;
    }

    if (intervalTR046) {
        clearInterval(intervalTR046);
        intervalTR046 = null;
    }
});


// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    // adapter.log.debug('adapter.on-stateChange: << stateChange >>');
    if (!state) {
        return;
    }
    if (id === adapter.namespace + ".calls.missedCount") {
        // New value of
        // adapter.log.debug("state.val: " + state.val);
        if (state.val == 0 || state.val == "0 ") {
            adapter.setState('calls.missedDateReset',         dateNow(),          true);
            adapter.log.debug("missed calls: counter zurückgesetzt " + dateNow());
        }
    }
    else if (id === adapter.namespace + ".wlan.enabled" && !state.ack) {
        adapter.log.debug(id + "=" + state.val);
        if (state.val != wlanState && intervalTR046 && adapter.config.enableWlan) {
            adapter.log.info("Changing WLAN to " + state.val);
            setWlanEnabled(adapter.config.fritzboxAddress, adapter.config.fritzboxUser, adapter.config.fritzboxPassword, state.val);
        }
    }
});



function fritzboxDateEpoch(date) {
    date = date || "";
    var year    = "20" + date.substring(6, 8), // Achtung: ab dem Jahr 2100 erzeugt die Funktion ein falsches Datum ;-)
        month   = parseInt(date.substring(3, 5)) - 1,
        day     = date.substring(0, 2),
        hour    = date.substring(9, 11),
        minute  = date.substring(12, 14),
        second  = date.substring(15, 17),
        time    = new Date(year, month, day, hour, minute, second);
    return Date.parse(time); // fritzbox message date in epoch
}

function dateEpochNow() {
    var now = new Date();
    now = Date.parse(now);  // aktuelle Zeit in epoch
    return now;
}

function dateNow() {
    var date     = new Date(dateEpochNow()),
        year     = date.getFullYear(),
        month    = date.getMonth() + 1,
        day      = date.getDate(),
        hour     = date.getHours(),
        minute   = date.getMinutes(),
        second   = date.getSeconds();
    if (month.toString().length == 1) {
        month  = '0' + month;
    }
    if (day.toString().length == 1) {
        day = '0' + day;
    }
    if (hour.toString().length == 1) {
        hour = '0' + hour;
    }
    if (minute.toString().length == 1) {
        minute = '0' + minute;
    }
    if (second.toString().length == 1) {
        second = '0' + second;
    }
    return day + "." + month + "." + year + " " + hour + ":" + minute;
}


function fill(n, str) {  // liefere Anzahl n nbsp in utf-8, wenn str nicht angegeben oder n-mal str
    var space = "";
    for (var i = 0; i < n; ++i) {
        space += ((!str) ? " " : str); // &nbsp; als utf-8 Code (Mac: alt+Leerzeichen) TODO: wie kann das nbsp-Leerzeichen in Wbstorm sichtbar gemacht werden
    }
    return space;
}

function dynamicSort(property) {
    var sortOrder = 1;
    if (property[0] === "-") {
        sortOrder = -1;
        property = property.substr(1);
    }
    return function (a,b) {
        var result = (a[property] < b[property]) ? -1 : (a[property] > b[property]) ? 1 : 0;
        return result * sortOrder;
    }
}


function numberFormat(number,length,align) {
// bringt die Rufnummer auf die konfigurierte Länge (zu kurz: mit utf-8 Non-breaking-space auffüllen // zu lang: kürzen und als letze "Ziffer" ein x ("x" nur, wenn es sich um Zahlen handelt).
    var onlyNumbers = /\D+/g;
    if (!number.match(onlyNumbers)) { // wenn der String numbers nur Ziffern enthält und diese in der Anzahl zu lang sind, kürzen und die letzte Ziffer gegen ein "x" ersetzen
        if (number.length > length) {
            number = number.substring(0, length - 1) + "x";
        }
    }
    number = number.substring(0,length); // sollte die externen numbern insgesamt länger sein, werden diese auf die max. gewünschte Länge gekürzt
    if (align !== "r") {
        number = number + fill(length - number.length); // richtet linksbündig aus und füllt nbsp; auf
    } else {
        number = fill(length - number.length) + number; // wenn allign = "r" wird rechtsbündig ausgerichtet
    }
    var i = 0;
    while (number.search(" ") >= 0) {
    number = number.replace(" ", " "); // alle normalen Leerzeichen gegen utf-8 non breaking spaces ersetzen
        if (!i) adapter.log.debug('Leerzeichen gegen utf-8 non breaking space ersetzt: <'+ number + ">");
        i++;
        if (i > 40) {
            adapter.log.warn("function numberFormat: zu langer Sting: " + number);
            break;
        }
    }
    return number;
}


function e164(extrnr) {
// wandelt eine externe Rufnummer in das e164 Format, z.B. rufnummer 4711321 wird zu +492114711321 (in Abhängigkeit des konfigurierten CC und AC)
    extrnr = extrnr.toString().replace(/\D+/g, ""); // nur Ziffern behalten, Rest kürzen
    if (extrnr === configUnknownNumber) return extrnr;
    if (extrnr.length > 0) {
        var i;
        var extrnr0 = 0;
        for (i = 0; i < extrnr.length; i++) {
            if (extrnr.substr(i, i + 1) != "0") {
                break;
            }
            extrnr0++;
        }
        extrnr = extrnr.slice(extrnr0, extrnr.length);

        if (extrnr0 == 0) {
            extrnr = "+" + configCC + configAC + extrnr;
        }
        if (extrnr0 == 1) {
            extrnr = "+" + configCC + extrnr;
        }
        if (extrnr0 == 2) {
            extrnr = "+" + extrnr;
        }

        if (extrnr0 < 0 && extrnr0 > 2) {
            adapter.log.error("fritzbox - ungültige externe Rufnummer, Anzahl führender Nullen prüfen");
        }
        validateE164(extrnr);
    }
    return extrnr;
}

function telLink(e164,formattedNumber) {
// erstellt aus einer e164 Rufnummer einen tel: link. Wird als 2. Parameter eine formatierte Rufnummer übergeben, wird diese dargestellt.
    var link = "";
    if (!formattedNumber) {
        link = '<a style="text-decoration: none;" href="tel:' + e164 + '">' + e164 + '</a>';
    } else {
        link = '<a style="text-decoration: none;" href="tel:' + e164 + '">' + formattedNumber + '</a>';
    }
    return link;
}


function validateE164(e164) {
// testet auf eine gültige internationale Rufnummer mit + am Anfang
    var regex = /^\+(?:[0-9] ?){6,14}[0-9]$/;
    if (regex.test(e164)) {
        // Valid international phone number
        return true;
    } else {
        // Invalid international phone number
        adapter.log.warn(e164 + " is not a vail int. phone number. Please check your configuration (Country + Area Code).");
        return false;
    }
}


function fritzboxDateToTableDate(fritzboxDate) {
    var year = fritzboxDate.substring(6,8);
    var month = fritzboxDate.substring(3,5);
    var day = fritzboxDate.substring(0,2);
    var hour = fritzboxDate.substring(9,11);
    var minute = fritzboxDate.substring(12,14);
    var second = fritzboxDate.substring(15,17);
    // var time = hour + ":" + minute + ":" + second + " ";
    // var time = hour + ":" + minute + "  ";
    // var date = day  + "." + month  + ".20" + year + " ";
    // var date = day  + "." + month  + "." + year + " ";
    var date = day + "." + month + ". " + hour + ":" + minute + "  "; // space = non-breaking-space in utf-8
    return date;
}


function durationForm(duration) {
// Dauer in Sekunden formatiert zu einem 7-stelligen String:
// "      -" = 0 Sek.
// "      5" = einstellige Sekunde
// "     27" = zweistellige Sekunden
// "   1:41" = einstellige Minuten
// "  59:32" = zweistellige Minuten
// "8:21:44" = mehr als eine Stunde, weniger als 10h
// "  >10 h" = mehr als 10h
    if (duration === "") {
        duration = fill(7);
        return duration;
    }
    var durationMin = Math.floor(parseInt(duration) / 60 );
    var durationSek = parseInt(duration) % 60;
    var durationStd = Math.floor(durationMin  / 60);
    durationMin %= 60;
    if (durationStd < 1) {
        if (durationMin < 1) {
            duration = durationSek;
        } else {
            duration = durationMin + ":" + fill((2- durationSek.toString().length),"0") + durationSek;
        }
    } else {
        duration = durationStd + ":" + fill((2- durationMin.toString().length),"0") + durationMin + ":" + fill((2- durationSek.toString().length),0) + durationSek;
    }
    duration = duration.toString();

    if (duration == "0") {
        duration = "-";
    }

    if (duration.length > 7) {
        duration = "> 10h";
    }
    duration = fill(7 - duration.toString().length) + duration; // auf 7-Stellen auffüllen
    return duration;
}


function getEventsList(anruferliste) {
    var text = '';
    for (var i = 0; i < anruferliste.length; i++) {
         text += (text ? '<br>\n' : '') + anruferliste[i];
//        text += anruferliste[i] + (text ? '<br>\n' : '');
    }
    return text;
}

function makeList(list,line,headline,howManyLines,showHeadline) {
    var lines = 0;
    if (showHeadline === true) {
        list.shift(); // erste Element im Array löschen (Kopfzeile)
        list.unshift(headline, line); // (Kopfzeile und aktueller Eintrag an Stelle 1 und 2 hinzufügen)
        lines = 1;
    } else {
        list.unshift(line);
    }

    if (list.length > howManyLines + lines) {
        list.length = howManyLines + lines;
    }
    return getEventsList(list);
}


function callmonitor(list) {
// Liste aktueller Anrufe (RING, CONNECT und CALL)
    var txt = '';
    for (var i = 0; i < list.length; i++) {
        txt += fritzboxDateToTableDate(call[list[i].id].dateStart) + " " + call[list[i].id].externalNumberForm;
        if (call[list[i].id].type === "CONNECT") {
            txt += durationForm(call[list[i].id].durationSecs2);
        }
        if (call[list[i].id].type === "RING") {
            txt += durationForm(call[list[i].id].durationRingSecs);
        }
        if (i < (list.length - 1)) {
            txt += (txt ? '<br>\n' : '');
        }
    }
    return txt;
}


function callmonitorAll(list) {
    var txt = '';
    for (var i = 0; i < list.length; i++) {
        var id = list[i].id;
        var intNr = fill(4 - call[id].extensionLine.length) + call[id].extensionLine;
        if (call[id].callSymbol == " -> ") {
            intNr = '<span style="color:red  ">RING</span>';
        }
        txt += fritzboxDateToTableDate(call[id].dateStart) + " " + call[id].externalNumberForm;
        txt += call[id].callSymbolColor + " ";
        txt += intNr;
        if (call[id].type === "CONNECT") {
            txt += " " + '<span style="color:green">' + "<b>" + durationForm(call[id].durationSecs2) + "</b>" + '</span>';
        }
        if (call[id].type === "RING") {
            txt += " " + '<span style="color:red  ">' + durationForm(call[id].durationRingSecs) + '</span>';
        }
        if (i < (list.length - 1)) {
            txt += (txt ? '<br>\n' : '');
        }
    }
    return txt;
}

function headlineMissedHTML() {
    var headlineHistoryMissedHTML =
        "<b>" + headlineDate +
        headlineExtnumber + nbsp +
        headlineOwnnumber + "</b>";
    return headlineHistoryMissedHTML;
}


function headlineAllTxt() {
    // Überschrift formatieren
    headlineDate = numberFormat(headlineDate, 14);
    headlineExtnumber = numberFormat(headlineExtnumber, configNumberLength);
    headlineDirection = numberFormat(headlineDirection, 4);
    headlineExtension = numberFormat(headlineExtension, 5, "r");   // 5 Zeichen lang, rechtsbündig
    headlineOwnnumber = numberFormat(headlineOwnnumber, configNumberLength);
    headlineLine = numberFormat(headlineLine, 4);
    headlineDuration = numberFormat(headlineDuration, 7, "r");     // 7 Zeichen lang, rechtsbündig
// Überschrift Anruferliste gesamt (txt)
    var headlineHistoryAllTxt =
        headlineDate +
        headlineExtnumber + nbsp +
        headlineDirection +
        headlineExtension + nbsp +
        headlineOwnnumber + nbsp +
        headlineLine + nbsp +
        headlineDuration;
    return headlineHistoryAllTxt;
}

function headlineAllHTML() {
// Überschrift Anruferliste gesamt (html)
    var headlineHistoryAllHTML = "<b>" + headlineAllTxt() + "</b>";

    return headlineHistoryAllHTML;
}


function clearRealtimeVars() {
     // da die Daten nach Start des Adapters oder neuer IP-Verbindung zur Fritzbox nicht konsitent sind, werden die Callmonitore gelöscht

    // Callmonitore löschen
    if (showCallmonitor) {
        adapter.setState('callmonitor.ring', "", true);
        adapter.setState('callmonitor.call', "", true);
        adapter.setState('callmonitor.connect', "", true);
        adapter.setState('callmonitor.all', "", true);
    }
    //Realtime Daten löschen
    adapter.setState('calls.ring',                               false ,    true);
    adapter.setState('calls.ringActualNumber',                   "" ,       true);
    adapter.setState('calls.ringActualNumbers',                  "" ,       true);
    adapter.setState('calls.connectNumber',                      "",        true);
    adapter.setState('calls.connectNumbers',                     "" ,       true);
    adapter.setState('calls.counterActualCalls.ringCount',       0 ,        true);
    adapter.setState('calls.counterActualCalls.callCount',       0 ,        true);
    adapter.setState('calls.counterActualCalls.connectCount',    0 ,        true);
    adapter.setState('calls.counterActualCalls.allActiveCount',  0 ,        true);

    // Liste der aktiven RINGs, CALLs, CONNECTs
    listRing            = [];
    listCall            = [];
    listConnect         = [];
    listAll             = [];

}






function adapterSetOnChange (object, value) {
    // ioBroker Objekte schreiben aber nur, wenn der Wert geändert wurde
    adapter.getState(object, function (err, state) {
        if (!err && state) {
            if (state.val !== value || !state.ack) {
                adapter.setState(object, value , true);
            }
        }
    });
}


function adapterSetOnUndefined (object, value) {
    adapter.getState(object, function (err, state) {
        if (!err && state) {
            var newValue = state.val || value;
            if (state.val == newValue) return; // vorhandene Werte nicht noch einmal schreiben
            adapter.setState(object, newValue, true);
//            adapter.log.info("Objekt: " + object + " Wert: " + state.val + " -> " + newValue + "  INIT: " +value);
        } else {
            adapter.setState(object, value, true);
        }
    });
}



function initVars() {
// alte Zustände übernehmen oder bei Erstinitalisierung sinnvolle Werte
    adapterSetOnUndefined("calls.missedCount", 0);
    adapterSetOnUndefined("calls.missedDateReset", dateNow());

    adapterSetOnUndefined("calls.ringLastNumber", "");
    adapterSetOnUndefined("calls.ringLastMissedNumber", "");
    adapterSetOnUndefined("calls.callLastNumber", "");

    adapterSetOnUndefined("telLinks.ringLastNumberTel", "");
    adapterSetOnUndefined("telLinks.ringLastMissedNumberTel", "");
    adapterSetOnUndefined("telLinks.callLastNumberTel", "");

    adapterSetOnUndefined("system.deltaTime", 0);
    adapterSetOnUndefined("system.deltaTimeOK", true);

    // config aus der Adapter Admin-Webseite übernehmen
    configCC                    = adapter.config.cc;    // "49",            // eigene Landesvorwahl ohne führende 0
    configAC                    = adapter.config.ac;    // "211",           // eigene Ortsvorwahl ohne führende 0
    configUnknownNumber         = numberFormat(adapter.config.unknownNumber, adapter.config.unknownNumber.length); // Leerzeichen gegen utf-8 nbsp ersetzen
    configNumberLength          = adapter.config.numberLength;
    if (configNumberLength < 4) {
        adapter.log.warn("Rufnummernlänge zu klein gewählt, geändert von " + configNumberLength + " auf 4");
        configNumberLength = 4;
    }
    if (configNumberLength > 30) {
        adapter.log.warn("Rufnummernlänge zu groß gewählt, geändert von " + configNumberLength + " auf 30");
        configNumberLength = 30;
    }

    configExternalLink          = adapter.config.externalLink;
    configShowHeadline          = adapter.config.showHeadline;

    showHistoryAllTableTxt      = adapter.config.showHistoryAllTableTxt;
    showHistoryAllTableHTML     = adapter.config.showHistoryAllTableHTML;
    showHistoryAllTableJSON     = adapter.config.showHistoryAllTableJSON;
    showCallmonitor             = adapter.config.showCallmonitor;
    showMissedTableHTML         = adapter.config.showMissedTableHTML;
    showMissedTableJSON         = adapter.config.showMissedTableJSON;

    // vorhandene Werte aus den ioBroker Objekte des Fritzbox Adapters rauslesen und in die globalen Variablen übernehmen
    adapter.getState('calls.missedCount', function (err, state) {
        if (!err && state) {
            objMissedCount = (state.val);
            missedCount = (state.val);
        }
    });


    if (adapter.config.showHeadline) {
        headlineTableAllTxt = headlineAllTxt();
        headlineTableAllHTML = headlineAllHTML();
        headlineTableMissedHTML = headlineMissedHTML();
    } else {
        headlineTableAllTxt = "";
        headlineTableAllHTML = "";
        headlineTableMissedHTML = "";
    }


    if (!showHistoryAllTableTxt) {
        adapter.setState('history.allTableTxt',    "deactivated",          true);
    } else {
        adapter.setState('history.allTableTxt',    headlineTableAllTxt,    true);
    }
    if (!showHistoryAllTableJSON) {
        adapter.setState('history.allTableJSON',   "deactivated",          true);
    }
    if (!showHistoryAllTableHTML) {
        adapter.setState('history.allTableHTML',   "deactivated",          true);
    } else {
        adapter.setState('history.allTableHTML',   headlineTableAllHTML,   true);
    }
    if (!showMissedTableHTML) {
        adapter.setState('history.missedTableHTML', "deactivated",         true);
    } else {
        adapter.setState('history.missedTableHTML', headlineTableMissedHTML,   true);
    }
    if (!showMissedTableJSON)     adapter.setState('history.missedTableJSON',   "deactivated", true);
    if (!showCallmonitor) {
        adapter.setState('callmonitor.connect', "deactivated", true);
        adapter.setState('callmonitor.ring', "deactivated", true);
        adapter.setState('callmonitor.call', "deactivated", true);
        adapter.setState('callmonitor.all', "deactivated", true);
    } else {
        adapter.setState('callmonitor.connect', "", true);
        adapter.setState('callmonitor.ring', "", true);
        adapter.setState('callmonitor.call', "", true);
        adapter.setState('callmonitor.all', "", true);
    }

    adapter.setState('wlan.enabled', false, true);
}





function parseData(message) {
    adapter.log.info("data from " + adapter.config.fritzboxAddress + ": " + message);
    message = message.toString('utf8');
    adapter.setState('message', message, true);

    var obj = message.split(";"); 	// speichert die Felder der Meldung in ein Array mit dem Namen "obj"
    var id = obj[2];
    call[id] = call[id] || {};

    var ringCount           = 0,
        callCount           = 0,
        connectCount        = 0,
        allActiveCount      = 0,
        ring                = null,
        ringActualNumber    = "";

    var ringActualNumbers   = [],
        connectNumbers      = [],
        connectNumber       = "";

    var cssGreen = '<span style="color:green">',
        cssRed   = '<span style="color:red  ">',
        cssBlack = '<span style="color:black">',
        cssColor = cssGreen,
        cssEnd   = "</span>";



    // ###########  Auswertung und Aufbau der Anruferinformationen aus der Fritzbox ###########

    // für alle Anruftypen identisch
    call[id].date            = obj[0];    // 01.07.15 12:34:56 - dd.mm.yy hh:mm:ss
    call[id].dateEpoch       = fritzboxDateEpoch(obj[0]); // fritzbox time
    call[id].dateEpochNow    = dateEpochNow();              // system time
    call[id].deltaTime       = (call[id].dateEpochNow  - call[id].dateEpoch) / 1000; // delta Time beetween system and fritzbox
    call[id].deltaTimeOK     = (call[id].deltaTime < configDeltaTimeOKSec);
    call[id].type            = obj[1];    // CALL (outgoing), RING (incoming), CONNECT (start), DISCONNECT (end)
    call[id].id              = obj[2];    // call identifier as integer


    // Outgoing call
    if (call[id].type == "CALL") {
        call[id].extensionLine      = obj[3];    // used extension line
        call[id].ownNumber          = obj[4];    // calling number - used own number
        call[id].externalNumber     = obj[5];    // called number
        call[id].lineType           = obj[6];    // line type
        call[id].durationSecs       = null;      // duration of the connect in sec
        call[id].durationForm       = null;      // duration of the connect in sec
        call[id].durationSecs2      = "";        // duration of the connect in sec, count during connect
        call[id].durationRingSecs   = "";        // duration ringing time in sec
        call[id].connect            = false;
        call[id].direction          = "out";
        call[id].dateStartEpoch     = fritzboxDateEpoch(obj[0]);
        call[id].dateConnEpoch      = null;
        call[id].dateEndEpoch       = null;
        call[id].dateStart          = obj[0];
        call[id].dateConn           = null;
        call[id].dateEnd            = null;
        call[id].callSymbol         = " <- "; // utf-8 nbsp
        call[id].callSymbolColor    = cssBlack + call[id].callSymbol + cssEnd;
    }
    else // Incoming (RING)
    if (call[id].type == "RING") {
        call[id].extensionLine      = "";        // used extension line
        call[id].ownNumber          = obj[4];    // called number - used own number
        call[id].externalNumber     = obj[3];    // calling number
        call[id].lineType           = obj[5];    // line type
        call[id].durationSecs       = null;      // duration of the connect in sec
        call[id].durationForm       = null;
        call[id].durationSecs2      = "";        // duration of the connect in sec, count during connect
        call[id].durationRingSecs   = 0;         // duration of ringing time in sec
        call[id].connect            = false;
        call[id].direction          = "in";
        call[id].dateStartEpoch     = fritzboxDateEpoch(obj[0]);
        call[id].dateConnEpoch      = null;
        call[id].dateEndEpoch       = null;
        call[id].dateStart          = obj[0];
        call[id].dateConn           = null;
        call[id].dateEnd            = null;
        call[id].callSymbol         = " -> "; // utf-8 nbsp
        call[id].callSymbolColor    = cssBlack + call[id].callSymbol + cssEnd;
    }
    else // Start of connect
    if (call[id].type == "CONNECT") {
        call[id].extensionLine      = obj[3];    // used extension line
        call[id].ownNumber          = call[id].ownNumber       || "????????";    // used own number
        call[id].externalNumber     = obj[4];    // connected number
        call[id].lineType           = call[id].lineType        || "????";        // line type
        call[id].durationSecs       = null;      // duration of the connect in sec
        call[id].durationForm       = null;
        call[id].durationSecs2      = 0;         // duration of the connect in sec, count during connect
        call[id].durationRingSecs   = call[id].durationRingSecs || "";         // duration of ringing time in sec
        call[id].connect            = true;
        call[id].direction          = call[id].direction       || "?";
        call[id].dateStartEpoch     = call[id].dateStartEpoch  || null;
        call[id].dateConnEpoch      = fritzboxDateEpoch(obj[0]);
        call[id].dateEndEpoch       = null;
        call[id].dateStart          = call[id].dateStart || obj[0];
        call[id].dateConn           = obj[0];
        call[id].dateEnd            = null;
        if (call[id].direction == "in") {
            call[id].callSymbol     = " ->>";
        } else {
            call[id].callSymbol     = "<<- "; // utf-8 nbsp
        }
        call[id].callSymbolColor    = cssGreen + "<b>" + call[id].callSymbol + "</b>" + cssEnd;
    }
    else // End of call
    if (call[id].type == "DISCONNECT") {
        call[id].extensionLine      = call[id].extensionLine   || "";          // used extension line
        call[id].ownNumber          = call[id].ownNumber       || "????????";    // used own number
        call[id].externalNumber     = call[id].externalNumber  || "????????";    // connected number
        call[id].lineType           = call[id].lineType        || "????";        // line type
        call[id].durationSecs       = obj[3];                                    // call duration in seconds
        call[id].durationForm       = durationForm(obj[3]);
        call[id].durationSecs2      = call[id].durationSecs;      // duration of the connect in sec
        call[id].durationRingSecs   = call[id].durationRingSecs || "";         // duration of ringing time in sec
        //call[id].connect            = call[id].connect         || null;
        call[id].direction          = call[id].direction       || "?";
        call[id].dateStartEpoch     = call[id].dateStartEpoch  || fritzboxDateEpoch(obj[0]);
        call[id].dateConnEpoch      = call[id].dateConnEpoch   || fritzboxDateEpoch(obj[0]);
        call[id].dateEndEpoch       = fritzboxDateEpoch(obj[0]);
        call[id].dateStart          = call[id].dateStart       || obj[0];
        call[id].dateConn           = call[id].dateConn        || obj[0];
        call[id].dateEnd            = obj[0];
        if (call[id].connect === false) {
            cssColor = cssRed;
            if (call[id].direction == "in") {
                call[id].callSymbol = " ->X";
            } else {
                call[id].callSymbol = "X<- "; // utf-8 nbsp
            }
        }
        call[id].callSymbol = call[id].callSymbol || "????";
        if (call[id].callSymbol === "????") cssColor = cssBlack;
        call[id].callSymbolColor    = cssColor + "<b>" + call[id].callSymbol + "</b>" + cssEnd;
    }
    else {
        adapter.log.error ("adapter fritzBox unknown event type " + call[id].type);
        return;
    }


    // für alle Anruftypen identisch
    call[id].unknownNumber = false;
    if (call[id].externalNumber === "" || call[id].externalNumber === null || call[id].externalNumber === configUnknownNumber || call[id].externalNumber === "????????") {
        if (call[id].externalNumber !== "????????") call[id].externalNumber         = configUnknownNumber;
        call[id].unknownNumber          = true;
    }
    call[id].ownNumberForm              = numberFormat(call[id].ownNumber,configNumberLength);
    call[id].externalNumberForm         = numberFormat(call[id].externalNumber,configNumberLength);
    call[id].ownNumberE164              = e164(call[id].ownNumber);
    call[id].externalE164               = e164(call[id].externalNumber);


    if (call[id].unknownNumber) {
        call[id].externalTelLink        = call[id].externalNumberForm;
        call[id].externalTelLinkCenter  = call[id].externalNumber;
    } else {
        call[id].externalTelLink        = telLink(call[id].externalE164,call[id].externalNumberForm);
        call[id].externalTelLinkCenter  = telLink(call[id].externalE164,call[id].externalNumber);
    }

/*
    adapter.log.debug("fritzBox event (date: " + call[id].date +
        ", dateEpoch: "     + call[id].dateEpoch +
        ", type: "          + call[id].type +
        ", ID: "            + call[id].id +
        ", exLine: "        + call[id].extensionLine +
        ", extern: "        + call[id].externalNumber +
        ", own: "           + call[id].ownNumber +
        ", duration: "      + call[id].durationSecs
   );

    adapter.log.debug("fritzBox event (delta time: " + call[id].deltaTime +
        ", delta time ok: "    + call[id].deltaTimeOK +
        ", symbol: "           + call[id].callSymbol +
        ", ext E164: "         + call[id].externalE164 +
        ", ext Tel Link: "     + call[id].externalTelLink
    );
*/


    // Listen aktuelle Gesprächszustände nach jeder Fritzbox Message, neuaufbauen und damit aktualisieren)
    listRing            = [];
    listCall            = [];
    listConnect         = [];
    listAll             = [];

    // Schleife, Anzahl der Call IDs im Array: Zählt die jeweiligen Zustände, ein Array je Zustand
    for (var i = 0; i < call.length; i++){
        if (call[i] != null) {
            // Call Status = RING
            if (call[i].type === "RING"){
                listRing[ringCount]                         = listRing[ringCount] || {};
                listRing[ringCount].id                      = call[i].id;
                listRing[ringCount].dateStartEpoch          = call[i].dateStartEpoch;
                ringCount++;
             }

            // Call Status = CALL
            if (call[i].type === "CALL"){
                listCall[callCount]                         = listCall[callCount] || {};
                listCall[callCount].id                      = call[i].id;
                listCall[callCount].dateStartEpoch          = call[i].dateStartEpoch;
                callCount++;
            }

            // Call Status = CONNECT
            if (call[i].type === "CONNECT"){
                listConnect[connectCount]                   = listConnect[connectCount] || {};
                listConnect[connectCount].id                = call[i].id;
                listConnect[connectCount].dateStartEpoch    = call[i].dateStartEpoch;
                connectCount++;
            }

            // Alle Status (RING, CALL, CONNECT)
            if (call[i].type !== "DISCONNECT"){
                listAll[allActiveCount]                     = listAll[allActiveCount] || {};
                listAll[allActiveCount].id                  = call[i].id;
                listAll[allActiveCount].dateStartEpoch      = call[i].dateStartEpoch;
                allActiveCount++;
            }
        }
    }

/*    adapter.log.debug("ringCount: " + ringCount +
        ", callCount: "             + callCount+
        ", connectCount: "          + connectCount +
        ", allActiveCount: "        + allActiveCount
    );
*/

// sortiert die ermittelten Listen nach der tatsächlichen Meldungszeit (Systemzeit)
    listRing.sort(dynamicSort("-dateStartEpoch"));      // Liste sortieren: jüngster Eintrag oben
    listCall.sort(dynamicSort("-dateStartEpoch"));      // Liste sortieren: jüngster Eintrag oben
    listConnect.sort(dynamicSort("-dateStartEpoch"));   // Liste sortieren: jüngster Eintrag oben
    listAll.sort(dynamicSort("-dateStartEpoch"));       // Liste sortieren: jüngster Eintrag oben


// aktuellste Anrufernummer wird als aktueller und neuester Anrufer (Ring) gespeichert (es kann noch mehr aktive RINGs geben, diese werden in "ringActualNumbers" gespeichert)
    if (listRing[0] != null) {
        ringActualNumber = call[listRing[0].id].externalNumber;
        ring = true;
    }

// kein aktiver Ring, ringAktuell löschen  && ring = false (kein Ring aktiv)
    if (ringCount < 1) {
        ringActualNumber = "";
        ring = false;
    }

    if (listConnect[0] != null) {
        connectNumber = call[listConnect[0].id].externalNumber;
    }
    objMissedCount = missedCount; // den alten errechneten Wert der verpassten Anrufe sichern
    // aktuellen Wert Anzahl verpasste Anrufe (missedCount aus den ioBroker Objekten auslesen)
    adapter.getState('calls.missedCount', function (err, state) {
        if (!err && state) {
            missedCount = (state.val);
        }
    });



    if (call[id].type == "DISCONNECT") {
        if (call[id].direction == "in") {
            ringLastNumber    = call[id].externalNumber;        // letzter Anrufer
            adapter.setState('calls.ringLastNumber',                     ringLastNumber ,            true);
            ringLastNumberTel = call[id].externalTelLinkCenter; // letzter Anrufer als wählbarer Link
            adapter.setState('calls.telLinks.ringLastNumberTel',         ringLastNumberTel,          true);

            if (!call[id].connect) { // letzter Anrufer, der verpasst wurde
                ringLastMissedNumber = call[id].externalNumber;
                adapter.setState('calls.ringLastMissedNumber',               ringLastMissedNumber ,      true);
                ringLastMissedNumberTel = call[id].externalTelLinkCenter;
                adapter.setState('calls.telLinks.ringLastMissedNumberTel',   ringLastMissedNumberTel ,   true);
            }
            // letzter verpasste Anruf wird hochgezählt, Zähler verpasste Anrufe (bis max. 999)
            // ioBroker Datenpunkt kann beschrieben und über ioBrkoer zurückgesetzt werden
            // das Datum, zu dem der Zähler auf 0 gesett wird, wird in calls.missedDateReset gespeichert.
            if (!call[id].connect) {
                ++missedCount;
                if (missedCount > 999) missedCount = 999;
            }
        } else
        if (call[id].direction == "out") {
            callLastNumber = call[id].externalNumber;
            adapter.setState('calls.callLastNumber',                     callLastNumber ,            true);
            callLastNumberTel = call[id].externalTelLinkCenter;
            adapter.setState('calls.telLinks.callLastNumberTel',         callLastNumberTel,          true);
        } else {
            adapter.log.warn ("Adapter starts during call. Some values are unknown.");
        }
    } // END DISCONNECT


    // aktuelle Rufnummeren der gerade laufenden Anrufe (RING)
    for (var i = 0; i < listRing.length; i++){
        ringActualNumbers.push(call[listRing[0].id].externalNumber);
    }

    // aktuelle Rufnummern der gerade laufenden Gespräche (CONNECT)
    for (var i = 0; i < listConnect.length; i++){
        connectNumbers.push(call[listConnect[i].id].externalNumber);
    }


    // Daten, die bei jeder Meldung aktualisiert werden
    adapter.setState('system.deltaTime',                         call[id].deltaTime ,        true);
    adapter.setState('system.deltaTimeOK',                       call[id].deltaTimeOK ,      true);
    if (!call[id].deltaTimeOK) adapter.log.warn("delta time between system and fritzbox: " + call[id].deltaTime + " sec");

    //Auf Änderungen im ioBroker Objekt reagieren und die lokale Variable auch ändern.
    if (objMissedCount !== missedCount) { // Zähler nur schreiben, wenn er sich verändert hat (wg. Traffic Überwachung des Objekts auf Änderung)
        adapter.setState('calls.missedCount',                        missedCount ,               true);
    }
    // adapter.log.debug ("objMissedCount: " + objMissedCount + "   missedCount: " + missedCount);

    //Realtime Daten
    adapterSetOnChange ("calls.ring" , ring);
    adapterSetOnChange ("calls.ringActualNumber" , ringActualNumber);
    adapterSetOnChange ("calls.ringActualNumbers" , ringActualNumbers.join());
    adapterSetOnChange ("calls.connectNumber" , connectNumber);
    adapterSetOnChange ("calls.connectNumbers" , connectNumbers.join());
    adapterSetOnChange ("calls.counterActualCalls.ringCount" , ringCount);
    adapterSetOnChange ("calls.counterActualCalls.callCount" , callCount);
    adapterSetOnChange ("calls.counterActualCalls.connectCount" , connectCount);
    adapterSetOnChange ("calls.counterActualCalls.allActiveCount" , allActiveCount);

    // History / Anruferlisten
    if (call[id].type == "DISCONNECT") {

        // Datensatz formatieren
        var extensionLine   = numberFormat(call[id].extensionLine, 5, "r");
        var line            = numberFormat(call[id].lineType, 4);
        // die externe Rufnummer, je nach Konfiguration als Link (tel:) oder Text
        var externalNumber  = call[id].externalTelLink;
        if (!configExternalLink) {
            externalNumber  = call[id].externalNumberForm;
        }

        // Einzelne Datenzeile Anruferliste gesamt (txt)
        var lineHistoryAllTxt =
            fritzboxDateToTableDate(call[id].date) +
            call[id].externalNumberForm + nbsp +
            call[id].callSymbol +
            extensionLine + nbsp +
            call[id].ownNumberForm + nbsp +
            call[id].lineType + nbsp +
            call[id].durationForm;

        // Einzelne Datenzeile Anruferliste gesamt (html)
        var lineHistoryAllHtml =
            fritzboxDateToTableDate(call[id].date) +
//            call[id].externalTelLink + nbsp +
            externalNumber + nbsp +
            call[id].callSymbolColor +
            extensionLine + nbsp +
            call[id].ownNumberForm + nbsp +
            call[id].lineType + nbsp +
            call[id].durationForm;

        // Datensatz html verpasste Anrufe erstellen && html & json schreiben
        if (!call[id].connect) {
            if (call[id].direction === "in") {
                // Datensatz verpasste Anrufe
                var lineHistoryMissedHtml =
                    fritzboxDateToTableDate(call[id].date) +
                    externalNumber + nbsp + call[id].ownNumberForm + nbsp;
                // aktuelle Call-ID als JSON für verpasste Anrufe wegschreiben
                adapter.setState('cdr.missedJSON',              JSON.stringify(call[id]),   true);
                adapter.setState('cdr.missedHTML',              lineHistoryMissedHtml,      true);
            }
        }

        if (showMissedTableHTML) {
            // Anruferliste verpasste Anrufe erstellen
            if (!call[id].connect) {
                if (call[id].direction === "in") {
                    var historyListMissedHtmlStr = makeList(historyListMissedHtml, lineHistoryMissedHtml, headlineTableMissedHTML, configHistoryMissedLines, configShowHeadline);
                    adapter.setState('history.missedTableHTML', historyListMissedHtmlStr, true);
                }
            }
        }


        if (showHistoryAllTableHTML) {
            // Tabelle html erstellen
            var historyListAllHtmlStr = makeList(historyListAllHtml,lineHistoryAllHtml,headlineTableAllHTML,configHistoryAllLines, configShowHeadline);
            adapter.setState('history.allTableHTML',        historyListAllHtmlStr,              true);
        }

        if (showHistoryAllTableTxt) {
            // Tabelle txt erstellen
            var historyListAllTxtStr = makeList(historyListAllTxt, lineHistoryAllTxt, headlineTableAllTxt, configHistoryAllLines, configShowHeadline);
            adapter.setState('history.allTableTxt', historyListAllTxtStr, true);
        }
        if (showHistoryAllTableJSON) {
            var lineHistoryAllJson = {
                "date" :            call[id].date,
                "externalNumber" :  call[id].externalNumber,
                "callSymbolColor" : call[id].callSymbolColor,
                "extensionLine" :   call[id].extensionLine,
                "ownNumber" :       call[id].ownNumber,
                "lineType" :        call[id].lineType,
                "durationForm" :    call[id].durationForm
            };
            // Anruferliste als JSON auf max Anzahl configHistoryAllLine beschränken
//        historyListAllJson.unshift(call[id]);
            historyListAllJson.unshift(lineHistoryAllJson);
            if (historyListAllJson.length   > configHistoryAllLines) {
                historyListAllJson.length   = configHistoryAllLines;
            }
            adapter.setState('history.allTableJSON',    JSON.stringify(historyListAllJson), true);
        }

//        adapter.log.debug("historyListAllJson Obj " +   JSON.stringify(historyListAllJson[0]) );  // erste Zeile der JSON ANruferliste im Log
//        adapter.log.debug("history all JSON Items: " +  historyListAllJson.length );              // Anzahl der JSON Elemente in der Anruferliste

        // aktuellen Datensatz des letzten Anrufs als JSON speicherern (für History und die weiteren Verarbeitung in Javascript, usw.)
        adapter.setState('cdr.json',                    JSON.stringify(call[id]),   true);
        adapter.setState('cdr.html',                    lineHistoryAllHtml,         true);
        adapter.setState('cdr.txt',                     lineHistoryAllTxt,          true);

        // try to get phonebook
        if (call[id].connect && call[id].direction === "in" && adapter.config.enableTAM) {
            getTAM(adapter.config.fritzboxAddress, adapter.config.fritzboxUser, adapter.config.fritzboxPassword);
        }

    } // End DSICONNECT


    if (showCallmonitor) {
        // alle drei Callmonitorausgaben mit Sekundenintervall werden auf einmal aktualisiert, auch, wenn ein Anrufzustand keinen aktiven Zähler hat
        // wird aus Performancegründen eine Optimierung benötigt, muss es für CONNECT und RING eigenen Intervalle geben
        // (weniger Traffic und Speicherplatz) # Hinweis: der Callmonitor kann auch in der Config (webadmin) deaktiviert werden
        if (allActiveCount && !intervalRunningCall) {
            // Do it every second
            intervalRunningCall = setInterval(function () {

                // adapter.log.debug("###### callmonitor aktiv ######");

                for (var i = 0; i < listConnect.length; i++) {
                    call[listConnect[i].id].durationSecs2 = dateEpochNow() / 1000 - call[listConnect[i].id].dateEpochNow / 1000;
                }
                for (var i = 0; i < listRing.length; i++) {
                    call[listRing[i].id].durationRingSecs = dateEpochNow() / 1000 - call[listRing[i].id].dateEpochNow / 1000;
                }
                adapterSetOnChange ("callmonitor.connect" , callmonitor(listConnect));
                adapterSetOnChange ("callmonitor.ring" , callmonitor(listRing));
                adapterSetOnChange ("callmonitor.all" , callmonitorAll(listAll));
//                adapter.setState('callmonitor.connect', callmonitor(listConnect), true);
//                adapter.setState('callmonitor.ring', callmonitor(listRing), true);
//                adapter.setState('callmonitor.all', callmonitorAll(listAll), true);

            }, 1000);
        } else if (!allActiveCount && intervalRunningCall) {
            // Stop interval
            clearInterval(intervalRunningCall);
            intervalRunningCall = null;
        }

        adapterSetOnChange ("callmonitor.call" , callmonitor(listCall));
//        adapter.setState('callmonitor.call', callmonitor(listCall), true);

        // wenn der Interval beendet wird, müssen die letzet Anrufe im Callmonitor auch bereinigt werden
        // die Callmonitorlisten werden zusätzlich zum Intervall mit jeder Fritzbox-Meldung aktualisiert
        // nur im else-Zweig im Intervall ist dies nicht ausreichend, wg. der Asynchonität
        adapterSetOnChange ("callmonitor.connect" , callmonitor(listConnect));
        adapterSetOnChange ("callmonitor.ring" , callmonitor(listRing));
        adapterSetOnChange ("callmonitor.all" , callmonitorAll(listAll));
    }



}



function handleWLANConfiguration(config) {
    //console.log(config);
    adapter.log.debug("WLAN: " + config['NewEnable']);
    wlanState = config['NewEnable'] == 1;
    adapterSetOnChange("wlan.enabled", wlanState);
}



function connectToTR064(host, user, password, callback) {
    var tr064 = new tr.TR064();
    tr064.initTR064Device(host, 49000, function (err, device) {
        if (!err) {
            device.startEncryptedCommunication(function (err, sslDev) {
                if (!err) {
                    sslDev.login(user, password);
                    callback(sslDev);
                }
                else {
                    adapter.log.warn("TR-064 error: " + err);
                }
            });
        }
        else {
            adapter.log.warn("TR-064 error: " + err);
        }
    });
}



function getWlanConfig(host, user, password, callback) {
    connectToTR064(host, user, password, function (sslDev) {
        var wlanConfig = sslDev.services["urn:dslforum-org:service:WLANConfiguration:1"];
        adapter.log.debug("TR-064: calling GetInfo()");
        wlanConfig.actions.GetInfo(function (err, result) {
            if (!err) {
                adapter.log.debug("TR-064: got result from GetInfo()");
                callback(result);
            }
            else {
                adapter.log.warn("TR-064 error: " + err);
            }
        });
    });
}



function setWlanEnabled(host, user, password, enabled) {
    connectToTR064(host, user, password, function (sslDev) {
        var wlanConfig = sslDev.services["urn:dslforum-org:service:WLANConfiguration:1"];
        adapter.log.debug("TR-064: calling SetEnable(" + enabled + ")");
        wlanConfig.actions.SetEnable({ 'NewEnable': enabled ? 1 : 0 }, function (err, result) {
            if (!err) {
                adapter.log.debug("TR-064: got result from SetEnable()");
            }
            else {
                adapter.log.warn("TR-064 error: " + err);
            }
        });
    });
}

function getTAM(host, user, password) {
    connectToTR064(host, user, password, function (sslDev) {
        var tam = sslDev.services["urn:dslforum-org:service:X_AVM-DE_TAM:1"];
        adapter.log.debug("TR-064: Calling GetMessageList()");
        tam.actions.GetMessageList({NewIndex: 0}, function(err, ret) {
            if (err) {
                adapter.log.warn("TR-064: Error while calling GetMessageList(): " + err);
            } else if (ret.NewURL && ret.NewURL.length > 0) {
                var url = ret.NewURL;
                adapter.log.debug("TR-064: Got TAM uri: " + url);
                var baseUrl = url.substring(0, url.lastIndexOf('/'));
                var sid = /sid=([\d\w]+)/.match(url)[1];
                adapter.log.debug(`TR-064: sid=${sid}`);

                var agentOptions;
				var agent;

				agentOptions = {
				  rejectUnauthorized: false
				};

				agent = new https.Agent(agentOptions);

                request({
				  url: url
				, method: 'GET'
				, agent: agent
				}, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                        adapter.log.debug("TR-064: Got valid TAM content from, starting to parse ...");
                        var parser = new xml2js.Parser();
                        parser.parseString(body, function (err, result) {
                            if (err) {
                                adapter.log.warn("TR-064: Error while parsing TAM content: " + err);
                            } else {
                                adapter.log.debug("TR-064: Successfully parsed TAM content, analyzing result ...");
                                var promises = [];
                                var messages = [];

                                for (var m = 0; m <= result.Root.Message.length; m++) {
                                    var message = result.Root.Message[m];
                                    if (typeof message != 'undefined') {
                                        promises.push(new Promise((resolve, reject) => {
                                            var msg = {
                                                index: message.Index[0],
                                                calledNumber: message.Called[0],
                                                date: message.Date[0],
                                                duration: message.Duration[0],
                                                callerName: message.Name[0],
                                                callerNumber: message.Number[0],
                                                audioFile: ''
                                            };
                                            if (!message.Path || message.Path.length < 1) {
                                                adapter.log.warn("TR-064: TAM message has no url");
                                                resolve(msg);
                                                return;
                                            }

                                            var callDate = message.Date[0].split('.').join("").split(':').join("").split(' ').join("");
                                            var file = `tam/${callDate}-${message.Number[0]}.wav`
                                            adapter.log.debug(`TR-064: TAM message file: ${file}`);
                                            if (existsSync(file)) {
                                                msg.audioFile = path.resolve(file);
                                                resolve(msg);
                                                return;
                                            }

                                            mkdirSync('tam', { recursive: true });

                                            var downloadUrl = message.Path[0];
                                            if (downloadUrl.startsWith('/')) {
                                                downloadUrl = baseUrl + downloadUrl;
                                            }
                                            if (downloadUrl.indexOf('sid=')<0){
                                                downloadUrl += `&sid=${sid}`;
                                            }
                                            adapter.log.debug(`TR-064: Download TAM audio file from ${downloadUrl}`);

                                            request({
                                                url: downloadUrl
                                              , method: 'GET'
                                              , agent: agent
                                              }, function (err, res, fileBody) {
                                                  adapter.log.debug(`Download statuscode: ${res.statusCode || 0}`);
                                                  if (!err && res.statusCode == 200) {
                                                    adapter.log.debug(`TR-064: Downloaded TAM audio file...`);

                                                    writeFile(file, fileBody);
                                                    msg.audioFile = path.resolve(file);
                                                    resolve(msg);
                                                  } else {
                                                    adapter.log.warn(
                                                        `TR-064: Error while downloading TAM audio file: ${err}`
                                                    );
                                                    resolve(msg);
                                                  }
                                                }
                                            );
                                        }).then((result) => {
                                            messages.push(result);
                                        }));
                                    }
                                }

                                Promise.all(promises).then(function(){
                                    adapter.setState('tam.messagesJSON', JSON.stringify(messages), true);
                                    adapter.log.debug("TR-064: Successfully analyzed TAM results");
                                });
                            }
                        });
                    } else {
						adapter.log.warn(
							`TR-064: Error while requesting TAM: ${error}`
						);
					}
                });
            }
        });
    });
}

function getPhonebook(host, user, password) {
    connectToTR064(host, user, password, function (sslDev) {
        var tel = sslDev.services["urn:dslforum-org:service:X_AVM-DE_OnTel:1"];
        adapter.log.debug("TR-064: Calling GetPhonebook()");
        tel.actions.GetPhonebook({ NewPhonebookID: '0' }, function (err, ret) {
            if (err) {
                adapter.log.warn("TR-064: Error while calling GetPhonebook(): " + err);
            } else if (ret.NewPhonebookURL && ret.NewPhonebookURL.length > 0) {
                var url = ret.NewPhonebookURL;
                adapter.log.debug("TR-064: Got phonebook uri: " + url);

				var agentOptions;
				var agent;

				agentOptions = {
				  rejectUnauthorized: false
				};

				agent = new https.Agent(agentOptions);

                request({
				  url: url
				, method: 'GET'
				, agent: agent
				}, function (error, response, body) {
                    if (!error && response.statusCode == 200) {
                        adapter.log.debug("TR-064: Got valid phonebook content from, starting to parse ...");
                        var parser = new xml2js.Parser();
                        parser.parseString(body, function (err, result) {
                            if (err) {
                                adapter.log.warn("TR-064: Error while parsing phonebook content: " + err);
                            } else {
                                adapter.log.debug("TR-064: Successfully parsed phonebook content, analyzing result ...");
                                var phonenumbers = []; // create an empty array for fetching all configured phone numbers from fritzbox
                                var phonebook = result.phonebooks.phonebook[0];
                                for (var c = 0; c <= phonebook.contact.length; c++) {
                                    var contact = phonebook.contact[c];
                                    if (typeof contact != 'undefined') {
                                        var entryName = contact.person[0].realName[0];
                                        for (var t = 0; t <= contact.telephony.length; t++) {
                                            var telephony = contact.telephony[t];
                                            if (typeof telephony != 'undefined') {
                                                for (var n = 0; n <= telephony.number.length; n++) {
                                                    var number = telephony.number[n];
                                                    if (typeof number != 'undefined') {
                                                        var entryNumber = number._;
                                                        var entryType = number.$.type;
                                                        if (entryNumber.startsWith('0') || entryNumber.startsWith('+')) {
                                                            phonenumbers.push({
                                                                key: entryNumber,
                                                                value: { name: entryName, type: entryType }
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                adapter.setState('phonebook.tableJSON', JSON.stringify(phonenumbers), true);
                                adapter.log.debug("TR-064: Successfully analyzed phonebook results");
                            }
                        });
                    } else {
						adapter.log.warn(
							`TR-064: Error while requesting phonebook: ${error}`
						);
					}
                });
            }
        });
    });
}

function connectToFritzbox(host) {
    clearRealtimeVars(); // IP-Verbindung neu: Realtimedaten werden gelöscht, da ggf. nicht konsistent
    var socketBox = net.connect({port: 1012, host: host}, function() {
        adapter.log.info("adapter connected to fritzbox: " + host);
    });

    var connecting = false;
    function restartConnection() {
        if (socketBox) {
            socketBox.end();
            socketBox = null;
        }

        if (!connecting){
            adapter.log.warn("restartConnection: " + host);
            clearRealtimeVars(); // IP-Verbindung neu: Realtimedaten werden gelöscht, da ggf. nicht konsistent
            connecting = setTimeout(function () {
                connectToFritzbox(host);
            }, 10000);
        }
    }

    socketBox.on('error', restartConnection);
    socketBox.on('close', restartConnection);
    socketBox.on('end',   restartConnection);

    socketBox.on('data',  parseData);   // Daten wurden aus der Fritzbox empfangen und dann in der Funktion parseData verarbeitet

    if ((adapter.config.enableWlan || adapter.config.enablePhonebook || adapter.config.enableTAM)
        && adapter.config.fritzboxUser && adapter.config.fritzboxPassword && adapter.config.fritzboxPassword.length) {
        adapter.log.info("Trying to connect to TR-064: " + host + ":49000");

        // try to get WLAN status and enable timer
        if (adapter.config.enableWlan) {
            getWlanConfig(host, adapter.config.fritzboxUser, adapter.config.fritzboxPassword, function (result) {
                adapter.log.info("Successfully connected to TR-064");
                handleWLANConfiguration(result);
                intervalTR046 = setInterval(function () {
                    getWlanConfig(host, adapter.config.fritzboxUser, adapter.config.fritzboxPassword, function (result) {
                        handleWLANConfiguration(result);
                    });
                }, 10000);
            });
        }

        // try to get phonebook
        if (adapter.config.enablePhonebook) {
            getPhonebook(host, adapter.config.fritzboxUser, adapter.config.fritzboxPassword);
        }

        // try to get tel answering machine
        if (adapter.config.enableTAM) {
            getTAM(host, adapter.config.fritzboxUser, adapter.config.fritzboxPassword);
        }
    }
}



function main() {
    adapter.log.debug("< main >");

    initVars(); // ioBroker Objekte übernehmen wenn vorhanden, sonst init

    // Zustandsänderungen innerhalb der ioBroker fritzbox-Adapterobjekte überwachen
//    adapter.subscribeForeignStates("node-red.0.fritzbox.*); // Beispiel um Datenpunkte anderer Adapter zu überwachen
    adapter.subscribeStates('calls.missedCount');
    adapter.subscribeStates('wlan.enabled');

    // TODO: IP-Prüfung bringt nichts, da auch Hostnamen / DNS erlaubt sind & eine Prüfung auf der Admin-Webseite ist sinnvoller
    var validIP = /^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
    if (!adapter.config.fritzboxAddress.match(validIP)) {
        adapter.log.info("no valid ip-Adress: " + adapter.config.fritzboxAddress) + ". Is it a valid hostname?";
    }

    if (adapter.config.fritzboxAddress && adapter.config.fritzboxAddress.length) {
        adapter.log.info("try to connect: " + adapter.config.fritzboxAddress);
        connectToFritzbox(adapter.config.fritzboxAddress);      // fritzbox
    } else {
        adapter.log.error("<< ip-Adresse der Fritzbox unbekannt >>");
    }

    /*
    // Zweitanmeldung für Entwicklung: Fritzbox Simulator / Callgenerator
    if (ipCallgen && ipCallgen.length) {
        adapter.log.info("try to connect: " + ipCallgen);
        connectToFritzbox(ipCallgen);   // callgen
    }
*/
    onlyOne = true; // Flag, um Aktionen nur einmal nach Programmstart auszuführen
}


