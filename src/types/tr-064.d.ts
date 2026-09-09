/**
 * Minimal typings for the `tr-064` module (https://www.npmjs.com/package/tr-064).
 *
 * The module ships no typings and is only used for the few SOAP actions below, so this
 * declaration covers exactly what the adapter calls, not the complete API of the package.
 */
declare module 'tr-064' {
    /** Node style callback of the `tr-064` module */
    type Tr064Callback<T> = (err: Error | null, result: T) => void;

    /** Result of a SOAP action - the FRITZ!Box returns all values as strings */
    type Tr064ActionResult = Record<string, string>;

    /** One SOAP action of a service, called with its input arguments and/or a callback */
    interface Tr064Action {
        (vars: Record<string, string | number>, callback: Tr064Callback<Tr064ActionResult>): void;
        (callback: Tr064Callback<Tr064ActionResult>): void;
    }

    /** One TR-064 service, e.g. `urn:dslforum-org:service:WLANConfiguration:1` */
    export interface Tr064Service {
        actions: Record<string, Tr064Action | undefined>;
    }

    /** A device found by `initTR064Device()` */
    export class Tr064Device {
        services: Record<string, Tr064Service | undefined>;

        /** Store the credentials used for the digest authentication of the following calls */
        login(user: string, password?: string): void;

        logout(): void;

        /** Determine the SSL port of the device and continue on https from then on */
        startEncryptedCommunication(callback: Tr064Callback<Tr064Device>): void;

        stopEncryptedCommunication(): void;
    }

    export class TR064 {
        initTR064Device(host: string, port: number, callback: Tr064Callback<Tr064Device>): void;
    }
}
