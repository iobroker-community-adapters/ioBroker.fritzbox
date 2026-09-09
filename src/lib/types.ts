/** Message type of the FRITZ!Box call monitor */
export type CallType = 'CALL' | 'RING' | 'CONNECT' | 'DISCONNECT';

/** Direction of a call. `?` if the adapter was started while the call was already running */
export type CallDirection = 'in' | 'out' | '?';

/**
 * One call, built up from the CALL/RING, CONNECT and DISCONNECT messages of the call monitor.
 * The complete object is published as `cdr.json` and `cdr.missedJSON`, so the property names
 * are part of the public API of this adapter and must not be renamed.
 */
export interface CallEntry {
    /** Time of the last message as delivered by the FRITZ!Box: `dd.mm.yy hh:mm:ss` */
    date: string;
    /** `date` in epoch ms (FRITZ!Box time) */
    dateEpoch: number;
    /** Time the message was received, in epoch ms (ioBroker system time) */
    dateEpochNow: number;
    /** Difference between system and FRITZ!Box time in seconds */
    deltaTime: number;
    deltaTimeOK: boolean;
    type: CallType;
    /** Call identifier of the FRITZ!Box, a number as string */
    id: string;
    extensionLine: string;
    ownNumber: string;
    externalNumber: string;
    lineType: string;
    /** Duration of the connection in seconds, set on DISCONNECT */
    durationSecs: string | null;
    /** `durationSecs` formatted to 7 characters */
    durationForm: string | null;
    /** Duration of the connection in seconds, counted up while connected */
    durationSecs2: string | number;
    /** Ringing time in seconds, counted up while ringing */
    durationRingSecs: string | number;
    connect: boolean;
    direction: CallDirection;
    dateStartEpoch: number | null;
    dateConnEpoch: number | null;
    dateEndEpoch: number | null;
    dateStart: string | null;
    dateConn: string | null;
    dateEnd: string | null;
    callSymbol: string;
    callSymbolColor: string;
    unknownNumber: boolean;
    ownNumberForm: string;
    externalNumberForm: string;
    ownNumberE164: string;
    externalE164: string;
    externalTelLink: string;
    externalTelLinkCenter: string;
}

/** Entry of one of the lists of the currently active calls */
export interface ActiveCall {
    id: string;
    dateStartEpoch: number | null;
}

/** One row of `history.allTableJSON` and `history.missedTableJSON` */
export interface HistoryLine {
    date: string;
    externalNumber: string;
    callSymbolColor: string;
    extensionLine: string;
    ownNumber: string;
    lineType: string;
    durationForm: string | null;
}

/** One answering machine message, published as `tam.messagesJSON` */
export interface TamMessage {
    index: string;
    calledNumber: string;
    date: string;
    duration: string;
    callerName: string;
    callerNumber: string;
    /** Absolute path of the downloaded audio file, empty if the message has none */
    audioFile: string;
}

/** One phone number of the FRITZ!Box phone book, published as `phonebook.tableJSON` */
export interface PhonebookEntry {
    key: string;
    value: { name: string; type: string };
}

/**
 * Structures of the XML documents the FRITZ!Box delivers. `xml2js` is used with its default
 * options, so every element becomes an array and attributes end up in `$`.
 */
export interface TamMessageXml {
    Index: string[];
    Called: string[];
    Date: string[];
    Duration: string[];
    Name: string[];
    Number: string[];
    Path?: string[];
}

export interface TamListXml {
    Root: {
        Message?: TamMessageXml[];
    };
}

export interface PhonebookNumberXml {
    /** The number itself (text content of the element) */
    _: string;
    $: { type: string };
}

export interface PhonebookTelephonyXml {
    number?: PhonebookNumberXml[];
}

export interface PhonebookContactXml {
    person: { realName: string[] }[];
    telephony: PhonebookTelephonyXml[];
}

export interface PhonebookXml {
    phonebooks: {
        phonebook: { contact: PhonebookContactXml[] }[];
    };
}
