/**
 *      ioBroker fritzbox Adapter
 *
 *      (c) 2015 Michael Herwig <ruhr@digheim.de>
 *
 *      MIT License
 *
 *
 *    Switch the call monitor of the FRITZ!Box on:
 *    Dialing #96*5* on a connected phone opens the TCP port 1012, #96*4* closes it again.
 *
 *    Format of the FRITZ!Box messages:
 *
 *    outgoing call:      date;CALL;      CallID;extension;callingNumber;calledNumber;lineType;
 *    incoming call:      date;RING;      CallID;callingNumber;calledNumber;lineType;
 *    established call:   date;CONNECT;   CallID;extension;connectedNumber;
 *    end of the call:    date;DISCONNECT;CallID;durationInSeconds;
 */
import * as utils from '@iobroker/adapter-core';
import { mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';

import { Tr064Client } from './lib/tr064';
import {
    NBSP,
    dateEpochNow,
    dateNow,
    durationForm,
    dynamicSort,
    e164,
    fill,
    fritzboxDateEpoch,
    fritzboxDateToTableDate,
    makeList,
    numberFormat,
    telLink,
} from './lib/utils';
import type { ActiveCall, CallEntry, CallType, HistoryLine } from './lib/types';

/** TCP port of the call monitor, opened by dialing #96*5* on a phone of the FRITZ!Box */
const CALLMONITOR_PORT = 1012;
/** Delay before a lost call monitor connection is established again */
const RECONNECT_DELAY_MS = 10_000;
/** Interval of the TR-064 WLAN state polling */
const WLAN_POLL_INTERVAL_MS = 10_000;
/** The call monitor states are updated once per second while calls are active */
const CALLMONITOR_INTERVAL_MS = 1_000;
/** `calls.missedCount` does not count higher than this */
const MAX_MISSED_COUNT = 999;
/** Deviation between the ioBroker system time and the FRITZ!Box time that still counts as OK */
const DELTA_TIME_OK_SEC = 5;
/** Number of entries of the list of all calls */
const HISTORY_ALL_LINES = 12;
/** Number of entries of the list of missed calls */
const HISTORY_MISSED_LINES = 10;
/** Limits of the configured length of the formatted external number */
const MIN_NUMBER_LENGTH = 4;
const MAX_NUMBER_LENGTH = 30;
/** Shown instead of a number that is not known (yet) */
const UNKNOWN_NUMBER = '????????';

const CSS_GREEN = '<span style="color:green">';
const CSS_RED = '<span style="color:red  ">';
const CSS_BLACK = '<span style="color:black">';
const CSS_END = '</span>';

/** The known message types of the call monitor */
const CALL_TYPES: CallType[] = ['CALL', 'RING', 'CONNECT', 'DISCONNECT'];

class Fritzbox extends utils.Adapter {
    /** All calls of this adapter run, indexed by the call id of the FRITZ!Box */
    private readonly calls: (CallEntry | undefined)[] = [];

    // configuration, taken over in `initVars()`
    private configCC = '';
    private configAC = '';
    private configUnknownNumber = '';
    private configNumberLength = 15;
    private configExternalLink = true;
    private configShowHeadline = true;
    private showHistoryAllTableTxt = true;
    private showHistoryAllTableHTML = true;
    private showHistoryAllTableJSON = true;
    private showCallmonitor = true;
    private showMissedTableHTML = true;
    private showMissedTableJSON = true;

    private missedCount = 0;
    private objMissedCount = 0;

    // the call lists, they keep their entries between the messages
    private readonly historyListAllHtml: string[] = [];
    private readonly historyListAllTxt: string[] = [];
    private readonly historyListAllJson: HistoryLine[] = [];
    private readonly historyListMissedJson: HistoryLine[] = [];
    private readonly historyListMissedHtml: string[] = [];

    // the column headers, they are formatted in place by `headlineAllTxt()`
    private headlineDate = 'Tag\u00A0\u00A0\u00A0\u00A0Zeit\u00A0\u00A0';
    private headlineExtnumber = 'ext.\u00A0Rufnr.';
    private headlineDirection = 'g<>k';
    private headlineExtension = 'Nbst';
    private headlineOwnnumber = 'Eigenes\u00A0Amt';
    private headlineLine = 'Ltg.';
    private headlineDuration = '\u00A0\u00A0Dauer';
    private headlineTableAllTxt = '';
    private headlineTableAllHTML = '';
    private headlineTableMissedHTML = '';

    // the currently active RINGs, CALLs and CONNECTs
    private listRing: ActiveCall[] = [];
    private listCall: ActiveCall[] = [];
    private listConnect: ActiveCall[] = [];
    private listAll: ActiveCall[] = [];

    /** One second timer of the call monitor, only running while calls are active */
    private intervalRunningCall: ioBroker.Interval | null = null;
    /** Timer of the TR-064 WLAN polling */
    private intervalTR046: ioBroker.Interval | null = null;
    /** Last WLAN state read from the FRITZ!Box */
    private wlanState: boolean | null = null;
    /** Set while a new call monitor connection is scheduled */
    private connecting: ioBroker.Timeout | null = null;
    private socketBox: Socket | null = null;
    /** Directory the answering machine files are stored in */
    private instanceDir = '';

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'fritzbox' });

        this.on('ready', () => this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('message', () => this.onMessage());
        this.on('unload', callback => this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        this.log.debug('adapter.on-ready: << READY >>');

        this.instanceDir = utils.getAbsoluteInstanceDataDir(this);
        try {
            mkdirSync(this.instanceDir, { recursive: true });
        } catch (e) {
            this.log.error(`Could not create instance directory: ${(e as Error).message}`);
        }

        await this.initVars();

        // watch the states of this instance that can be written from outside
        this.subscribeStates('calls.missedCount');
        this.subscribeStates('wlan.enabled');

        // an IP check alone is not enough, host names are allowed as well - so this only warns
        const validIP = /^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;
        if (!this.config.fritzboxAddress.match(validIP)) {
            this.log.info(`no valid ip-Adress: ${this.config.fritzboxAddress}`);
        }

        if (this.config.fritzboxAddress?.length) {
            this.log.info(`try to connect: ${this.config.fritzboxAddress}`);
            this.connectToFritzbox(this.config.fritzboxAddress);
        } else {
            this.log.error('<< ip-Adresse der Fritzbox unbekannt >>');
        }
    }

    private onMessage(): void {
        this.log.debug('adapter.on-message: << MESSAGE >>');
    }

    private onUnload(callback: () => void): void {
        this.log.debug('adapter.on-unload: << UNLOAD >>');
        this.clearRealtimeVars();

        if (this.connecting) {
            this.clearTimeout(this.connecting);
            this.connecting = null;
        }

        if (this.intervalRunningCall) {
            this.clearInterval(this.intervalRunningCall);
            this.intervalRunningCall = null;
        }

        if (this.intervalTR046) {
            this.clearInterval(this.intervalTR046);
            this.intervalTR046 = null;
        }

        if (this.socketBox) {
            // the listeners have to go first, `destroy()` would otherwise trigger the
            // `close` handler and schedule a reconnect while the adapter is shutting down
            this.socketBox.removeAllListeners();
            try {
                this.socketBox.destroy();
            } catch {
                // ignore
            }
            this.socketBox = null;
        }

        callback();
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }
        if (id === `${this.namespace}.calls.missedCount`) {
            // loose comparison as before: the counter is reset by writing any falsy value
            if (state.val == 0 || state.val == '0 ') {
                void this.setState('calls.missedDateReset', dateNow(), true);
                this.log.debug(`missed calls: counter zurückgesetzt ${dateNow()}`);
            }
        } else if (id === `${this.namespace}.wlan.enabled` && !state.ack) {
            this.log.debug(`${id}=${state.val}`);
            // loose comparison as before, the state may arrive as a string
            if (state.val != this.wlanState && this.intervalTR046 && this.config.enableWlan) {
                this.log.info(`Changing WLAN to ${state.val}`);
                void this.createTr064Client().setWlanEnabled(!!state.val);
            }
        }
    }

    /** Take over the old states if there are any, otherwise write sensible initial values */
    private async initVars(): Promise<void> {
        await this.setOnUndefined('calls.missedCount', 0);
        await this.setOnUndefined('calls.missedDateReset', dateNow());

        await this.setOnUndefined('calls.ringLastNumber', '');
        await this.setOnUndefined('calls.ringLastMissedNumber', '');
        await this.setOnUndefined('calls.callLastNumber', '');

        await this.setOnUndefined('calls.telLinks.ringLastNumberTel', '');
        await this.setOnUndefined('calls.telLinks.ringLastMissedNumberTel', '');
        await this.setOnUndefined('calls.telLinks.callLastNumberTel', '');

        await this.setOnUndefined('system.deltaTime', 0);
        await this.setOnUndefined('system.deltaTimeOK', true);

        // take over the configuration of the admin page
        this.configCC = this.config.cc;
        this.configAC = this.config.ac;
        // replace the normal spaces by utf-8 non-breaking spaces
        this.configUnknownNumber = numberFormat(this.config.unknownNumber, this.config.unknownNumber.length);

        // the HTML admin stored this as a string, JsonConfig stores a number - accept both
        this.configNumberLength = parseInt(String(this.config.numberLength), 10);
        if (Number.isNaN(this.configNumberLength) || this.configNumberLength < MIN_NUMBER_LENGTH) {
            this.log.warn(
                `Rufnummernlänge zu klein gewählt, geändert von ${this.config.numberLength} auf ${MIN_NUMBER_LENGTH}`,
            );
            this.configNumberLength = MIN_NUMBER_LENGTH;
        }
        if (this.configNumberLength > MAX_NUMBER_LENGTH) {
            this.log.warn(
                `Rufnummernlänge zu groß gewählt, geändert von ${this.config.numberLength} auf ${MAX_NUMBER_LENGTH}`,
            );
            this.configNumberLength = MAX_NUMBER_LENGTH;
        }

        this.configExternalLink = this.config.externalLink;
        this.configShowHeadline = this.config.showHeadline;

        this.showHistoryAllTableTxt = this.config.showHistoryAllTableTxt;
        this.showHistoryAllTableHTML = this.config.showHistoryAllTableHTML;
        this.showHistoryAllTableJSON = this.config.showHistoryAllTableJSON;
        this.showCallmonitor = this.config.showCallmonitor;
        this.showMissedTableHTML = this.config.showMissedTableHTML;
        this.showMissedTableJSON = this.config.showMissedTableJSON;

        // continue counting the missed calls where the last adapter run stopped
        const missedState = await this.getStateAsync('calls.missedCount');
        if (missedState) {
            this.objMissedCount = missedState.val as number;
            this.missedCount = missedState.val as number;
        }

        if (this.config.showHeadline) {
            this.headlineTableAllTxt = this.headlineAllTxt();
            this.headlineTableAllHTML = this.headlineAllHTML();
            this.headlineTableMissedHTML = this.headlineMissedHTML();
        } else {
            this.headlineTableAllTxt = '';
            this.headlineTableAllHTML = '';
            this.headlineTableMissedHTML = '';
        }

        if (!this.showHistoryAllTableTxt) {
            await this.setState('history.allTableTxt', 'deactivated', true);
        } else {
            await this.setState('history.allTableTxt', this.headlineTableAllTxt, true);
        }
        if (!this.showHistoryAllTableJSON) {
            await this.setState('history.allTableJSON', 'deactivated', true);
        }
        if (!this.showHistoryAllTableHTML) {
            await this.setState('history.allTableHTML', 'deactivated', true);
        } else {
            await this.setState('history.allTableHTML', this.headlineTableAllHTML, true);
        }
        if (!this.showMissedTableHTML) {
            await this.setState('history.missedTableHTML', 'deactivated', true);
        } else {
            await this.setState('history.missedTableHTML', this.headlineTableMissedHTML, true);
        }
        if (!this.showMissedTableJSON) {
            await this.setState('history.missedTableJSON', 'deactivated', true);
        }
        if (!this.showCallmonitor) {
            await this.setState('callmonitor.connect', 'deactivated', true);
            await this.setState('callmonitor.ring', 'deactivated', true);
            await this.setState('callmonitor.call', 'deactivated', true);
            await this.setState('callmonitor.all', 'deactivated', true);
        } else {
            await this.setState('callmonitor.connect', '', true);
            await this.setState('callmonitor.ring', '', true);
            await this.setState('callmonitor.call', '', true);
            await this.setState('callmonitor.all', '', true);
        }

        await this.setState('wlan.enabled', false, true);
    }

    /** Write a state, but only if its value changed */
    private async setOnChange(id: string, value: ioBroker.StateValue): Promise<void> {
        const state = await this.getStateAsync(id);
        if (state && (state.val !== value || !state.ack)) {
            await this.setState(id, value, true);
        }
    }

    /** Write a state only if it has no value yet */
    private async setOnUndefined(id: string, value: ioBroker.StateValue): Promise<void> {
        const state = await this.getStateAsync(id);
        if (state) {
            const newValue = state.val || value;
            // loose comparison as before, so that 0 and '' count as "already set"
            if (state.val == newValue) {
                return; // do not write existing values again
            }
            await this.setState(id, newValue, true);
        } else {
            await this.setState(id, value, true);
        }
    }

    // ############################ formatting of the call lists ############################

    private headlineMissedHTML(): string {
        return `<b>${this.headlineDate}${this.headlineExtnumber}${NBSP}${this.headlineOwnnumber}</b>`;
    }

    /** Format the column headers and build the headline of the txt list of all calls */
    private headlineAllTxt(): string {
        this.headlineDate = numberFormat(this.headlineDate, 14);
        this.headlineExtnumber = numberFormat(this.headlineExtnumber, this.configNumberLength);
        this.headlineDirection = numberFormat(this.headlineDirection, 4);
        this.headlineExtension = numberFormat(this.headlineExtension, 5, 'r');
        this.headlineOwnnumber = numberFormat(this.headlineOwnnumber, this.configNumberLength);
        this.headlineLine = numberFormat(this.headlineLine, 4);
        this.headlineDuration = numberFormat(this.headlineDuration, 7, 'r');

        return (
            this.headlineDate +
            this.headlineExtnumber +
            NBSP +
            this.headlineDirection +
            this.headlineExtension +
            NBSP +
            this.headlineOwnnumber +
            NBSP +
            this.headlineLine +
            NBSP +
            this.headlineDuration
        );
    }

    private headlineAllHTML(): string {
        return `<b>${this.headlineAllTxt()}</b>`;
    }

    /** List of the currently active calls of one state (RING, CONNECT or CALL) */
    private callmonitor(list: ActiveCall[]): string {
        let txt = '';
        for (let i = 0; i < list.length; i++) {
            const call = this.calls[Number(list[i].id)];
            if (!call) {
                continue;
            }
            txt += `${fritzboxDateToTableDate(call.dateStart ?? '')}${NBSP}${call.externalNumberForm}`;
            if (call.type === 'CONNECT') {
                txt += durationForm(call.durationSecs2);
            }
            if (call.type === 'RING') {
                txt += durationForm(call.durationRingSecs);
            }
            if (i < list.length - 1) {
                txt += txt ? '<br>\n' : '';
            }
        }
        return txt;
    }

    /** List of all currently active calls, whatever state they are in */
    private callmonitorAll(list: ActiveCall[]): string {
        let txt = '';
        for (let i = 0; i < list.length; i++) {
            const call = this.calls[Number(list[i].id)];
            if (!call) {
                continue;
            }
            let intNr = fill(4 - call.extensionLine.length) + call.extensionLine;
            if (call.callSymbol === '\u00A0->\u00A0') {
                intNr = `${CSS_RED}RING</span>`;
            }
            txt += `${fritzboxDateToTableDate(call.dateStart ?? '')}${NBSP}${call.externalNumberForm}`;
            txt += `${call.callSymbolColor}${NBSP}`;
            txt += intNr;
            if (call.type === 'CONNECT') {
                txt += `${NBSP}${CSS_GREEN}<b>${durationForm(call.durationSecs2)}</b>${CSS_END}`;
            }
            if (call.type === 'RING') {
                txt += `${NBSP}${CSS_RED}${durationForm(call.durationRingSecs)}${CSS_END}`;
            }
            if (i < list.length - 1) {
                txt += txt ? '<br>\n' : '';
            }
        }
        return txt;
    }

    /** The data after a start or a new connection is not consistent - clear the realtime states */
    private clearRealtimeVars(): void {
        if (this.showCallmonitor) {
            void this.setState('callmonitor.ring', '', true);
            void this.setState('callmonitor.call', '', true);
            void this.setState('callmonitor.connect', '', true);
            void this.setState('callmonitor.all', '', true);
        }

        void this.setState('calls.ring', false, true);
        void this.setState('calls.ringActualNumber', '', true);
        void this.setState('calls.ringActualNumbers', '', true);
        void this.setState('calls.connectNumber', '', true);
        void this.setState('calls.connectNumbers', '', true);
        void this.setState('calls.counterActualCalls.ringCount', 0, true);
        void this.setState('calls.counterActualCalls.callCount', 0, true);
        void this.setState('calls.counterActualCalls.connectCount', 0, true);
        void this.setState('calls.counterActualCalls.allActiveCount', 0, true);

        this.listRing = [];
        this.listCall = [];
        this.listConnect = [];
        this.listAll = [];
    }

    // ################################ the call monitor ################################

    /** One message of the call monitor */
    private parseData(message: Buffer): void {
        const text = message.toString('utf8');
        this.log.info(`data from ${this.config.fritzboxAddress}: ${text}`);
        void this.setState('message', text, true);

        const obj = text.split(';');
        const id = obj[2];
        const index = Number(id);
        const previous = this.calls[index];

        const type = obj[1] as CallType;
        if (!CALL_TYPES.includes(type)) {
            // The original stored the half filled entry before it gave up, which made every
            // following message stumble over it. Nothing is stored now.
            this.log.error(`adapter fritzBox unknown event type ${type}`);
            return;
        }

        const dateEpoch = fritzboxDateEpoch(obj[0]);
        const nowEpoch = dateEpochNow();
        const deltaTime = (nowEpoch - dateEpoch) / 1000;

        // the part that is the same for all message types
        const call = {
            date: obj[0],
            dateEpoch,
            dateEpochNow: nowEpoch,
            deltaTime,
            deltaTimeOK: deltaTime < DELTA_TIME_OK_SEC,
            type,
            id,
        } as CallEntry;
        this.calls[index] = call;

        let cssColor = CSS_GREEN;

        if (type === 'CALL') {
            // outgoing call
            call.extensionLine = obj[3];
            call.ownNumber = obj[4];
            call.externalNumber = obj[5];
            call.lineType = obj[6];
            call.durationSecs = null;
            call.durationForm = null;
            call.durationSecs2 = '';
            call.durationRingSecs = '';
            call.connect = false;
            call.direction = 'out';
            call.dateStartEpoch = dateEpoch;
            call.dateConnEpoch = null;
            call.dateEndEpoch = null;
            call.dateStart = obj[0];
            call.dateConn = null;
            call.dateEnd = null;
            call.callSymbol = '\u00A0<-\u00A0';
            call.callSymbolColor = CSS_BLACK + call.callSymbol + CSS_END;
        } else if (type === 'RING') {
            // incoming call
            call.extensionLine = '';
            call.ownNumber = obj[4];
            call.externalNumber = obj[3];
            call.lineType = obj[5];
            call.durationSecs = null;
            call.durationForm = null;
            call.durationSecs2 = '';
            call.durationRingSecs = 0;
            call.connect = false;
            call.direction = 'in';
            call.dateStartEpoch = dateEpoch;
            call.dateConnEpoch = null;
            call.dateEndEpoch = null;
            call.dateStart = obj[0];
            call.dateConn = null;
            call.dateEnd = null;
            call.callSymbol = '\u00A0->\u00A0';
            call.callSymbolColor = CSS_BLACK + call.callSymbol + CSS_END;
        } else if (type === 'CONNECT') {
            // start of the connection
            call.extensionLine = obj[3];
            call.ownNumber = previous?.ownNumber || UNKNOWN_NUMBER;
            call.externalNumber = obj[4];
            call.lineType = previous?.lineType || '????';
            call.durationSecs = null;
            call.durationForm = null;
            call.durationSecs2 = 0;
            call.durationRingSecs = previous?.durationRingSecs || '';
            call.connect = true;
            call.direction = previous?.direction || '?';
            call.dateStartEpoch = previous?.dateStartEpoch || null;
            call.dateConnEpoch = dateEpoch;
            call.dateEndEpoch = null;
            call.dateStart = previous?.dateStart || obj[0];
            call.dateConn = obj[0];
            call.dateEnd = null;
            call.callSymbol = call.direction === 'in' ? '\u00A0->>' : '<<-\u00A0';
            call.callSymbolColor = `${CSS_GREEN}<b>${call.callSymbol}</b>${CSS_END}`;
        } else {
            // end of the call
            call.extensionLine = previous?.extensionLine || '';
            call.ownNumber = previous?.ownNumber || UNKNOWN_NUMBER;
            call.externalNumber = previous?.externalNumber || UNKNOWN_NUMBER;
            call.lineType = previous?.lineType || '????';
            call.durationSecs = obj[3];
            call.durationForm = durationForm(obj[3]);
            call.durationSecs2 = call.durationSecs;
            call.durationRingSecs = previous?.durationRingSecs || '';
            call.connect = previous?.connect ?? false;
            call.direction = previous?.direction || '?';
            call.dateStartEpoch = previous?.dateStartEpoch || dateEpoch;
            call.dateConnEpoch = previous?.dateConnEpoch || dateEpoch;
            call.dateEndEpoch = dateEpoch;
            call.dateStart = previous?.dateStart || obj[0];
            call.dateConn = previous?.dateConn || obj[0];
            call.dateEnd = obj[0];
            // a DISCONNECT without a preceding message means the adapter was started during the
            // call - it then gets the `????` symbol, not the symbol of a missed call
            if (previous?.connect === false) {
                cssColor = CSS_RED;
                call.callSymbol = call.direction === 'in' ? '\u00A0->X' : 'X<-\u00A0';
            } else {
                call.callSymbol = previous?.callSymbol || '????';
            }
            if (call.callSymbol === '????') {
                cssColor = CSS_BLACK;
            }
            call.callSymbolColor = `${cssColor}<b>${call.callSymbol}</b>${CSS_END}`;
        }

        // the part that is the same for all message types again
        call.unknownNumber = false;
        if (
            call.externalNumber === '' ||
            call.externalNumber === null ||
            call.externalNumber === this.configUnknownNumber ||
            call.externalNumber === UNKNOWN_NUMBER
        ) {
            if (call.externalNumber !== UNKNOWN_NUMBER) {
                call.externalNumber = this.configUnknownNumber;
            }
            call.unknownNumber = true;
        }
        call.ownNumberForm = numberFormat(call.ownNumber, this.configNumberLength, undefined, this.log);
        call.externalNumberForm = numberFormat(call.externalNumber, this.configNumberLength, undefined, this.log);
        call.ownNumberE164 = e164(call.ownNumber, this.configCC, this.configAC, this.configUnknownNumber, this.log);
        call.externalE164 = e164(call.externalNumber, this.configCC, this.configAC, this.configUnknownNumber, this.log);

        if (call.unknownNumber) {
            call.externalTelLink = call.externalNumberForm;
            call.externalTelLinkCenter = call.externalNumber;
        } else {
            call.externalTelLink = telLink(call.externalE164, call.externalNumberForm);
            call.externalTelLinkCenter = telLink(call.externalE164, call.externalNumber);
        }

        const counters = this.rebuildActiveLists();
        this.publishCallState(call, counters);
        if (type === 'DISCONNECT') {
            this.publishHistory(call);
        }
        this.updateCallmonitor(counters.allActiveCount);
    }

    /** Rebuild the lists of the active calls after every message and count them */
    private rebuildActiveLists(): {
        ringCount: number;
        callCount: number;
        connectCount: number;
        allActiveCount: number;
    } {
        this.listRing = [];
        this.listCall = [];
        this.listConnect = [];
        this.listAll = [];

        for (const call of this.calls) {
            if (!call) {
                continue;
            }
            const entry: ActiveCall = { id: call.id, dateStartEpoch: call.dateStartEpoch };
            if (call.type === 'RING') {
                this.listRing.push(entry);
            }
            if (call.type === 'CALL') {
                this.listCall.push(entry);
            }
            if (call.type === 'CONNECT') {
                this.listConnect.push(entry);
            }
            if (call.type !== 'DISCONNECT') {
                this.listAll.push({ ...entry });
            }
        }

        const counters = {
            ringCount: this.listRing.length,
            callCount: this.listCall.length,
            connectCount: this.listConnect.length,
            allActiveCount: this.listAll.length,
        };
        this.log.debug(
            `ringCount: ${counters.ringCount}, callCount: ${counters.callCount}, connectCount: ${counters.connectCount}, allActiveCount: ${counters.allActiveCount}`,
        );

        // youngest entry first
        this.listRing.sort(dynamicSort('-dateStartEpoch'));
        this.listCall.sort(dynamicSort('-dateStartEpoch'));
        this.listConnect.sort(dynamicSort('-dateStartEpoch'));
        this.listAll.sort(dynamicSort('-dateStartEpoch'));

        return counters;
    }

    /** Everything that is updated with every message of the call monitor */
    private publishCallState(
        call: CallEntry,
        counters: { ringCount: number; callCount: number; connectCount: number; allActiveCount: number },
    ): void {
        let ringActualNumber = '';
        let ring: boolean | null = null;
        let connectNumber = '';

        // the youngest ringing call is the current one, all of them go to `ringActualNumbers`
        if (this.listRing[0] != null) {
            ringActualNumber = this.calls[Number(this.listRing[0].id)]?.externalNumber ?? '';
            ring = true;
        }
        if (counters.ringCount < 1) {
            ringActualNumber = '';
            ring = false;
        }
        if (this.listConnect[0] != null) {
            connectNumber = this.calls[Number(this.listConnect[0].id)]?.externalNumber ?? '';
        }

        this.objMissedCount = this.missedCount; // keep the counter of the previous message
        // reading the counter back is asynchronous, the value therefore only arrives after this
        // function is through - kept as it was, so that the counting does not change
        void this.getStateAsync('calls.missedCount').then(state => {
            if (state) {
                this.missedCount = state.val as number;
            }
        });

        if (call.type === 'DISCONNECT') {
            if (call.direction === 'in') {
                void this.setState('calls.ringLastNumber', call.externalNumber, true);
                void this.setState('calls.telLinks.ringLastNumberTel', call.externalTelLinkCenter, true);

                if (!call.connect) {
                    void this.setState('calls.ringLastMissedNumber', call.externalNumber, true);
                    void this.setState('calls.telLinks.ringLastMissedNumberTel', call.externalTelLinkCenter, true);

                    // the counter can be written and reset from ioBroker, the date of the last
                    // reset is stored in `calls.missedDateReset`
                    ++this.missedCount;
                    if (this.missedCount > MAX_MISSED_COUNT) {
                        this.missedCount = MAX_MISSED_COUNT;
                    }
                }
            } else if (call.direction === 'out') {
                void this.setState('calls.callLastNumber', call.externalNumber, true);
                void this.setState('calls.telLinks.callLastNumberTel', call.externalTelLinkCenter, true);
            } else {
                this.log.warn('Adapter starts during call. Some values are unknown.');
            }
        }

        const ringActualNumbers: string[] = [];
        for (let i = 0; i < this.listRing.length; i++) {
            // this always takes the youngest ringing call - kept as it was
            ringActualNumbers.push(this.calls[Number(this.listRing[0].id)]?.externalNumber ?? '');
        }

        const connectNumbers: string[] = [];
        for (let i = 0; i < this.listConnect.length; i++) {
            connectNumbers.push(this.calls[Number(this.listConnect[i].id)]?.externalNumber ?? '');
        }

        void this.setState('system.deltaTime', call.deltaTime, true);
        void this.setState('system.deltaTimeOK', call.deltaTimeOK, true);
        if (!call.deltaTimeOK) {
            this.log.warn(`delta time between system and fritzbox: ${call.deltaTime} sec`);
        }

        if (this.objMissedCount !== this.missedCount) {
            void this.setState('calls.missedCount', this.missedCount, true);
        }

        void this.setOnChange('calls.ring', ring);
        void this.setOnChange('calls.ringActualNumber', ringActualNumber);
        void this.setOnChange('calls.ringActualNumbers', ringActualNumbers.join());
        void this.setOnChange('calls.connectNumber', connectNumber);
        void this.setOnChange('calls.connectNumbers', connectNumbers.join());
        void this.setOnChange('calls.counterActualCalls.ringCount', counters.ringCount);
        void this.setOnChange('calls.counterActualCalls.callCount', counters.callCount);
        void this.setOnChange('calls.counterActualCalls.connectCount', counters.connectCount);
        void this.setOnChange('calls.counterActualCalls.allActiveCount', counters.allActiveCount);
    }

    /** The call lists, written when a call ended */
    private publishHistory(call: CallEntry): void {
        const extensionLine = numberFormat(call.extensionLine, 5, 'r', this.log);
        // the external number as a link or as text, depending on the configuration
        const externalNumber = this.configExternalLink ? call.externalTelLink : call.externalNumberForm;

        const lineHistoryAllTxt =
            fritzboxDateToTableDate(call.date) +
            call.externalNumberForm +
            NBSP +
            call.callSymbol +
            extensionLine +
            NBSP +
            call.ownNumberForm +
            NBSP +
            call.lineType +
            NBSP +
            call.durationForm;

        const lineHistoryAllHtml =
            fritzboxDateToTableDate(call.date) +
            externalNumber +
            NBSP +
            call.callSymbolColor +
            extensionLine +
            NBSP +
            call.ownNumberForm +
            NBSP +
            call.lineType +
            NBSP +
            call.durationForm;

        const missed = !call.connect && call.direction === 'in';
        let lineHistoryMissedHtml = '';
        if (missed) {
            lineHistoryMissedHtml =
                fritzboxDateToTableDate(call.date) + externalNumber + NBSP + call.ownNumberForm + NBSP;
            void this.setState('cdr.missedJSON', JSON.stringify(call), true);
            void this.setState('cdr.missedHTML', lineHistoryMissedHtml, true);
        }

        if (this.showMissedTableHTML && missed) {
            void this.setState(
                'history.missedTableHTML',
                makeList(
                    this.historyListMissedHtml,
                    lineHistoryMissedHtml,
                    this.headlineTableMissedHTML,
                    HISTORY_MISSED_LINES,
                    this.configShowHeadline,
                ),
                true,
            );
        }

        if (this.showMissedTableJSON && !call.connect) {
            this.historyListMissedJson.unshift(this.historyLine(call));
            if (this.historyListMissedJson.length > HISTORY_MISSED_LINES) {
                this.historyListMissedJson.length = HISTORY_MISSED_LINES;
            }
            void this.setState('history.missedTableJSON', JSON.stringify(this.historyListMissedJson), true);
        }

        if (this.showHistoryAllTableHTML) {
            void this.setState(
                'history.allTableHTML',
                makeList(
                    this.historyListAllHtml,
                    lineHistoryAllHtml,
                    this.headlineTableAllHTML,
                    HISTORY_ALL_LINES,
                    this.configShowHeadline,
                ),
                true,
            );
        }

        if (this.showHistoryAllTableTxt) {
            void this.setState(
                'history.allTableTxt',
                makeList(
                    this.historyListAllTxt,
                    lineHistoryAllTxt,
                    this.headlineTableAllTxt,
                    HISTORY_ALL_LINES,
                    this.configShowHeadline,
                ),
                true,
            );
        }

        if (this.showHistoryAllTableJSON) {
            this.historyListAllJson.unshift(this.historyLine(call));
            if (this.historyListAllJson.length > HISTORY_ALL_LINES) {
                this.historyListAllJson.length = HISTORY_ALL_LINES;
            }
            void this.setState('history.allTableJSON', JSON.stringify(this.historyListAllJson), true);
        }

        // the complete record of the last call, for the history and for scripts
        void this.setState('cdr.json', JSON.stringify(call), true);
        void this.setState('cdr.html', lineHistoryAllHtml, true);
        void this.setState('cdr.txt', lineHistoryAllTxt, true);

        if (call.connect && call.direction === 'in' && this.config.enableTAM) {
            void this.updateTam();
        }
    }

    /** One row of the JSON call lists */
    private historyLine(call: CallEntry): HistoryLine {
        return {
            date: call.date,
            externalNumber: call.externalNumber,
            callSymbolColor: call.callSymbolColor,
            extensionLine: call.extensionLine,
            ownNumber: call.ownNumber,
            lineType: call.lineType,
            durationForm: call.durationForm,
        };
    }

    /**
     * Start or stop the one second timer of the call monitor and write the lists. All four
     * outputs are updated together, a separate interval per state would save traffic but is
     * not worth the complexity here.
     */
    private updateCallmonitor(allActiveCount: number): void {
        if (!this.showCallmonitor) {
            return;
        }

        if (allActiveCount && !this.intervalRunningCall) {
            this.intervalRunningCall =
                this.setInterval(() => {
                    for (const active of this.listConnect) {
                        const call = this.calls[Number(active.id)];
                        if (call) {
                            call.durationSecs2 = dateEpochNow() / 1000 - call.dateEpochNow / 1000;
                        }
                    }
                    for (const active of this.listRing) {
                        const call = this.calls[Number(active.id)];
                        if (call) {
                            call.durationRingSecs = dateEpochNow() / 1000 - call.dateEpochNow / 1000;
                        }
                    }
                    void this.setOnChange('callmonitor.connect', this.callmonitor(this.listConnect));
                    void this.setOnChange('callmonitor.ring', this.callmonitor(this.listRing));
                    void this.setOnChange('callmonitor.all', this.callmonitorAll(this.listAll));
                }, CALLMONITOR_INTERVAL_MS) ?? null;
        } else if (!allActiveCount && this.intervalRunningCall) {
            this.clearInterval(this.intervalRunningCall);
            this.intervalRunningCall = null;
        }

        void this.setOnChange('callmonitor.call', this.callmonitor(this.listCall));

        // the lists have to be written here as well: when the interval is stopped, the last
        // calls still have to disappear from the call monitor
        void this.setOnChange('callmonitor.connect', this.callmonitor(this.listConnect));
        void this.setOnChange('callmonitor.ring', this.callmonitor(this.listRing));
        void this.setOnChange('callmonitor.all', this.callmonitorAll(this.listAll));
    }

    // ##################################### TR-064 #####################################

    private createTr064Client(): Tr064Client {
        return new Tr064Client({
            host: this.config.fritzboxAddress,
            user: this.config.fritzboxUser,
            password: this.config.fritzboxPassword,
            log: this.log,
        });
    }

    private async updateWlanState(): Promise<void> {
        const enabled = await this.createTr064Client().getWlanEnabled();
        if (enabled === null) {
            return;
        }
        this.wlanState = enabled;
        await this.setOnChange('wlan.enabled', enabled);
    }

    private async updateTam(): Promise<void> {
        const messages = await this.createTr064Client().getTamMessages(join(this.instanceDir, 'tam'));
        if (messages) {
            await this.setState('tam.messagesJSON', JSON.stringify(messages), true);
        }
    }

    private async updatePhonebook(): Promise<void> {
        const phonenumbers = await this.createTr064Client().getPhonebook();
        if (phonenumbers) {
            await this.setState('phonebook.tableJSON', JSON.stringify(phonenumbers), true);
        }
    }

    // ############################## call monitor connection ##############################

    private connectToFritzbox(host: string): void {
        // a new connection means the realtime data may be inconsistent
        this.clearRealtimeVars();

        this.socketBox = connect({ port: CALLMONITOR_PORT, host }, () => {
            this.log.info(`adapter connected to fritzbox: ${host}`);
        });

        const restartConnection = (): void => this.restartConnection(host);
        this.socketBox.on('error', restartConnection);
        this.socketBox.on('close', restartConnection);
        this.socketBox.on('end', restartConnection);
        this.socketBox.on('data', (data: Buffer) => this.parseData(data));

        if (
            (this.config.enableWlan || this.config.enablePhonebook || this.config.enableTAM) &&
            this.config.fritzboxUser &&
            this.config.fritzboxPassword?.length
        ) {
            this.log.info(`Trying to connect to TR-064: ${host}:49000`);

            if (this.config.enableWlan) {
                void this.createTr064Client()
                    .getWlanEnabled()
                    .then(async enabled => {
                        if (enabled === null) {
                            return;
                        }
                        this.log.info('Successfully connected to TR-064');
                        this.wlanState = enabled;
                        await this.setOnChange('wlan.enabled', enabled);
                        this.intervalTR046 =
                            this.setInterval(() => void this.updateWlanState(), WLAN_POLL_INTERVAL_MS) ?? null;
                    });
            }

            if (this.config.enablePhonebook) {
                void this.updatePhonebook();
            }

            if (this.config.enableTAM) {
                void this.updateTam();
            }
        }
    }

    private restartConnection(host: string): void {
        if (this.socketBox) {
            this.socketBox.end();
            this.socketBox = null;
        }

        if (!this.connecting) {
            this.log.warn(`restartConnection: ${host}`);
            // a new connection means the realtime data may be inconsistent
            this.clearRealtimeVars();
            this.connecting =
                this.setTimeout(() => {
                    // has to be cleared before reconnecting, otherwise the guard above stays
                    // closed forever and the adapter never tries a second time
                    this.connecting = null;
                    this.connectToFritzbox(host);
                }, RECONNECT_DELAY_MS) ?? null;
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Fritzbox(options);
} else {
    // otherwise start the instance directly
    (() => new Fritzbox())();
}
