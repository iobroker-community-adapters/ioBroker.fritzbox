// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** IP address or hostname of the FRITZ!Box */
            fritzboxAddress: string;
            /** TR-064 user, only needed for WLAN, phone book and answering machine */
            fritzboxUser: string;
            /** TR-064 password, stored encrypted (see `encryptedNative` in io-package.json) */
            fritzboxPassword: string;
            /** Read the WLAN state via TR-064 and allow switching it */
            enableWlan: boolean;
            /** Read the phone book via TR-064 */
            enablePhonebook: boolean;
            /** Read the answering machine via TR-064 */
            enableTAM: boolean;

            /** Own country code without the leading zeros, e.g. `49` */
            cc: string;
            /** Own area code without the leading zero, e.g. `211` */
            ac: string;
            /** How a suppressed or unknown external number is shown */
            unknownNumber: string;

            /** Show a headline above the html/txt call lists */
            showHeadline: boolean;
            /** Number of characters the external number is padded/shortened to (4 - 30) */
            numberLength: number;
            /** Render the external number as a dialable `tel:` link */
            externalLink: boolean;

            showHistoryAllTableTxt: boolean;
            showHistoryAllTableHTML: boolean;
            showHistoryAllTableJSON: boolean;
            showMissedTableHTML: boolean;
            showMissedTableJSON: boolean;
            /** Update `callmonitor.*` every second while calls are active */
            showCallmonitor: boolean;
        }
    }
}

// this is required so the above is treated as a module
export {};
