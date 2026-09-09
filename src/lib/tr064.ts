import axios from 'axios';
import { createWriteStream, existsSync, mkdirSync, readdir, unlink } from 'node:fs';
import { Agent } from 'node:https';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { TR064, type Tr064Device, type Tr064Service } from 'tr-064';
import { parseStringPromise } from 'xml2js';

import type { PhonebookContactXml, PhonebookEntry, PhonebookXml, TamListXml, TamMessage, TamMessageXml } from './types';

/** Port of the TR-064 interface of the FRITZ!Box */
const TR064_PORT = 49000;

const WLAN_SERVICE = 'urn:dslforum-org:service:WLANConfiguration:1';
const TAM_SERVICE = 'urn:dslforum-org:service:X_AVM-DE_TAM:1';
const ONTEL_SERVICE = 'urn:dslforum-org:service:X_AVM-DE_OnTel:1';

/**
 * Everything the adapter reads from the FRITZ!Box via TR-064: the WLAN state, the answering
 * machine and the phone book. All methods log the problem and resolve with `null` if the box
 * cannot be reached - exactly as the callback version did, which simply never called back.
 */
export class Tr064Client {
    private readonly host: string;
    private readonly user: string;
    private readonly password: string;
    private readonly log: ioBroker.Logger;
    /** The certificate of the FRITZ!Box is self signed, so it cannot be verified */
    private readonly agent = new Agent({ rejectUnauthorized: false });

    public constructor(options: { host: string; user: string; password: string; log: ioBroker.Logger }) {
        this.host = options.host;
        this.user = options.user;
        this.password = options.password;
        this.log = options.log;
    }

    /** Read `WLANConfiguration:1 GetInfo()` and return whether the WLAN is switched on */
    public async getWlanEnabled(): Promise<boolean | null> {
        const wlanConfig = await this.getService(WLAN_SERVICE);
        if (!wlanConfig) {
            return null;
        }
        this.log.debug('TR-064: calling GetInfo()');
        const result = await this.callAction(wlanConfig, 'GetInfo');
        if (!result) {
            return null;
        }
        this.log.debug('TR-064: got result from GetInfo()');
        this.log.debug(`WLAN: ${result.NewEnable}`);
        return result.NewEnable === '1' || Number(result.NewEnable) === 1;
    }

    /** Switch the WLAN of the FRITZ!Box on or off */
    public async setWlanEnabled(enabled: boolean): Promise<void> {
        const wlanConfig = await this.getService(WLAN_SERVICE);
        if (!wlanConfig) {
            return;
        }
        this.log.debug(`TR-064: calling SetEnable(${enabled})`);
        const result = await this.callAction(wlanConfig, 'SetEnable', { NewEnable: enabled ? 1 : 0 });
        if (result) {
            this.log.debug('TR-064: got result from SetEnable()');
        }
    }

    /**
     * Read the message list of the answering machine and download the audio files that are not
     * downloaded yet into `tamDir`. Audio files of messages that no longer exist are removed.
     */
    public async getTamMessages(tamDir: string): Promise<TamMessage[] | null> {
        const tam = await this.getService(TAM_SERVICE);
        if (!tam) {
            return null;
        }
        this.log.debug('TR-064: Calling GetMessageList()');
        const ret = await this.callAction(tam, 'GetMessageList', { NewIndex: 0 }, 'GetMessageList');
        if (!ret) {
            return null;
        }
        const url = ret.NewURL;
        if (!url?.length) {
            return null;
        }
        this.log.debug(`TR-064: Got TAM uri: ${url}`);
        const baseUrl = url.substring(0, url.lastIndexOf('/'));
        const sid = url.match(/sid=([\d\w]+)/)?.[1] ?? '';
        this.log.debug(`TR-064: sid=${sid}`);

        let body: string;
        try {
            const response = await axios.get<string>(url, { httpsAgent: this.agent, responseType: 'text' });
            body = response.data;
        } catch (e) {
            this.log.warn(`TR-064: Error while requesting TAM: ${(e as Error).message}`);
            return null;
        }
        this.log.debug('TR-064: Got valid TAM content from, starting to parse ...');

        let parsed: TamListXml;
        try {
            parsed = (await parseStringPromise(body)) as TamListXml;
        } catch (e) {
            this.log.warn(`TR-064: Error while parsing TAM content: ${(e as Error).message}`);
            return null;
        }
        this.log.debug('TR-064: Successfully parsed TAM content, analyzing result ...');

        try {
            mkdirSync(tamDir, { recursive: true });
        } catch (e) {
            this.log.error(`Could not create instance directory: ${(e as Error).message}`);
        }

        const messages: TamMessage[] = [];
        for (const message of parsed.Root.Message ?? []) {
            messages.push(await this.readTamMessage(message, tamDir, baseUrl, sid));
        }
        messages.sort((m1, m2) => (m1.index > m2.index ? 1 : m1.index < m2.index ? -1 : 0));

        this.cleanupTamFiles(messages);
        this.log.debug('TR-064: Successfully analyzed TAM results');
        return messages;
    }

    /** Read the first phone book of the FRITZ!Box and return all external numbers in it */
    public async getPhonebook(): Promise<PhonebookEntry[] | null> {
        const tel = await this.getService(ONTEL_SERVICE);
        if (!tel) {
            return null;
        }
        this.log.debug('TR-064: Calling GetPhonebook()');
        const ret = await this.callAction(tel, 'GetPhonebook', { NewPhonebookID: '0' }, 'GetPhonebook');
        if (!ret) {
            return null;
        }
        const url = ret.NewPhonebookURL;
        if (!url?.length) {
            return null;
        }
        this.log.debug(`TR-064: Got phonebook uri: ${url}`);

        let body: string;
        try {
            const response = await axios.get<string>(url, { httpsAgent: this.agent, responseType: 'text' });
            body = response.data;
        } catch (e) {
            this.log.warn(`TR-064: Error while requesting phonebook: ${(e as Error).message}`);
            return null;
        }
        this.log.debug('TR-064: Got valid phonebook content from, starting to parse ...');

        let parsed: PhonebookXml;
        try {
            parsed = (await parseStringPromise(body)) as PhonebookXml;
        } catch (e) {
            this.log.warn(`TR-064: Error while parsing phonebook content: ${(e as Error).message}`);
            return null;
        }
        this.log.debug('TR-064: Successfully parsed phonebook content, analyzing result ...');

        const phonenumbers: PhonebookEntry[] = [];
        const phonebook = parsed.phonebooks.phonebook[0];
        for (const contact of phonebook.contact) {
            this.collectContactNumbers(contact, phonenumbers);
        }
        this.log.debug('TR-064: Successfully analyzed phonebook results');
        return phonenumbers;
    }

    /** All external numbers of one phone book contact */
    private collectContactNumbers(contact: PhonebookContactXml, phonenumbers: PhonebookEntry[]): void {
        const entryName = contact.person[0].realName[0];
        for (const telephony of contact.telephony) {
            for (const number of telephony?.number ?? []) {
                const entryNumber = number._;
                const entryType = number.$.type;
                if (entryNumber.startsWith('0') || entryNumber.startsWith('+')) {
                    phonenumbers.push({ key: entryNumber, value: { name: entryName, type: entryType } });
                }
            }
        }
    }

    /** One message of the answering machine, downloading its audio file if it is not there yet */
    private async readTamMessage(
        message: TamMessageXml,
        tamDir: string,
        baseUrl: string,
        sid: string,
    ): Promise<TamMessage> {
        const msg: TamMessage = {
            index: message.Index[0],
            calledNumber: message.Called[0],
            date: message.Date[0],
            duration: message.Duration[0],
            callerName: message.Name[0],
            callerNumber: message.Number[0],
            audioFile: '',
        };

        if (!message.Path?.length) {
            this.log.warn('TR-064: TAM message has no url');
            return msg;
        }

        const callDate = message.Date[0].split('.').join('').split(':').join('').split(' ').join('');
        const file = join(tamDir, `${callDate}-${message.Number[0]}.wav`);
        this.log.debug(`TR-064: TAM message file: ${file}`);
        if (existsSync(file)) {
            msg.audioFile = resolve(file);
            return msg;
        }

        let downloadUrl = message.Path[0];
        if (downloadUrl.startsWith('/')) {
            downloadUrl = baseUrl + downloadUrl;
        }
        if (!downloadUrl.includes('sid=')) {
            downloadUrl += `&sid=${sid}`;
        }
        this.log.debug(`TR-064: Download TAM audio file from ${downloadUrl}`);

        const stream = createWriteStream(file);
        try {
            const response = await axios.get<Readable>(downloadUrl, {
                httpsAgent: this.agent,
                responseType: 'stream',
            });
            await pipeline(response.data, stream);
            msg.audioFile = resolve(file);
        } catch (e) {
            unlink(file, () => {
                // the file is incomplete, an error while removing it is not worth a message
            });
            this.log.warn(`TR-064: Error while downloading TAM audio file: ${(e as Error).message}`);
        }
        return msg;
    }

    /** Remove the audio files of messages that are no longer on the answering machine */
    private cleanupTamFiles(messages: TamMessage[]): void {
        // FIXME: 'tam' is relative to the working directory of the adapter process and not the
        // instance directory the files are written to, so this cleanup never finds them.
        readdir('tam', (err, files) => {
            if (err) {
                this.log.warn(`TR-064: Error reading files from dir /tam: ${err.message}`);
                return;
            }
            files.forEach(name => {
                const file = resolve(`tam/${name}`);
                if (!messages.find(msg => msg.audioFile === file)) {
                    this.log.debug(`TR-064: Remove old tam audio file: ${file}`);
                    unlink(file, error => {
                        if (error) {
                            this.log.warn(`TR-064: Error deleting file ${file}: ${error.message}`);
                        }
                    });
                }
            });
        });
    }

    /** Connect to the FRITZ!Box, switch to https and log in */
    private connect(): Promise<Tr064Device | null> {
        return new Promise(resolve => {
            const tr064 = new TR064();
            tr064.initTR064Device(this.host, TR064_PORT, (err, device) => {
                if (err || !device) {
                    this.log.warn(`TR-064 error: ${err?.message}`);
                    resolve(null);
                    return;
                }
                device.startEncryptedCommunication((err, sslDev) => {
                    if (err) {
                        this.log.warn(`TR-064 error: ${err.message}`);
                        resolve(null);
                        return;
                    }
                    sslDev.login(this.user, this.password);
                    resolve(sslDev);
                });
            });
        });
    }

    /** Connect and return one service of the FRITZ!Box */
    private async getService(name: string): Promise<Tr064Service | null> {
        const sslDev = await this.connect();
        return sslDev?.services[name] ?? null;
    }

    /**
     * Call one SOAP action. `errorPrefix` is the name used in the warning, so that the messages
     * stay the ones the adapter logged before.
     */
    private callAction(
        service: Tr064Service,
        action: string,
        vars?: Record<string, string | number>,
        errorPrefix?: string,
    ): Promise<Record<string, string> | null> {
        return new Promise(resolve => {
            const soapAction = service.actions[action];
            if (!soapAction) {
                this.log.warn(`TR-064 error: the FRITZ!Box does not offer the action ${action}`);
                resolve(null);
                return;
            }
            const callback = (err: Error | null, result: Record<string, string>): void => {
                if (err) {
                    this.log.warn(
                        errorPrefix
                            ? `TR-064: Error while calling ${errorPrefix}(): ${err.message}`
                            : `TR-064 error: ${err.message}`,
                    );
                    resolve(null);
                    return;
                }
                resolve(result);
            };
            if (vars) {
                soapAction(vars, callback);
            } else {
                soapAction(callback);
            }
        });
    }
}
