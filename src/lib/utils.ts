/**
 * Formatting helpers of the FRITZ!Box adapter.
 *
 * All table output of this adapter is padded with utf-8 non-breaking spaces so that the columns
 * stay aligned in the VIS widgets. Every space that is meant to be a padding character therefore
 * has to be `NBSP`, never a normal space.
 */

/** utf-8 non-breaking space - the padding character of all formatted output */
export const NBSP = '\u00A0';

/**
 * Convert the date of a FRITZ!Box message (`dd.mm.yy hh:mm:ss`) into epoch milliseconds.
 * Note: from the year 2100 on this produces a wrong date.
 */
export function fritzboxDateEpoch(date: string): number {
    date = date || '';
    const year = `20${date.substring(6, 8)}`;
    const month = parseInt(date.substring(3, 5), 10) - 1;
    const day = date.substring(0, 2);
    const hour = date.substring(9, 11);
    const minute = date.substring(12, 14);
    const second = date.substring(15, 17);
    const time = new Date(
        parseInt(year, 10),
        month,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        parseInt(second, 10),
    );
    return Date.parse(time.toString());
}

/** Current system time in epoch milliseconds */
export function dateEpochNow(): number {
    return Date.parse(new Date().toString());
}

/** Current system time as `dd.mm.yyyy hh:mm` */
export function dateNow(): string {
    const date = new Date(dateEpochNow());
    const year = date.getFullYear();
    const month = `0${date.getMonth() + 1}`.slice(-2);
    const day = `0${date.getDate()}`.slice(-2);
    const hour = `0${date.getHours()}`.slice(-2);
    const minute = `0${date.getMinutes()}`.slice(-2);
    return `${day}.${month}.${year} ${hour}:${minute}`;
}

/** `n` times `str`, or `n` non-breaking spaces if `str` is not given */
export function fill(n: number, str?: string | number): string {
    let space = '';
    for (let i = 0; i < n; ++i) {
        space += !str ? NBSP : String(str);
    }
    return space;
}

/** Comparator for `Array.sort()`. A leading `-` in `property` sorts descending. */
export function dynamicSort<T extends object>(property: string): (a: T, b: T) => number {
    let sortOrder = 1;
    if (property[0] === '-') {
        sortOrder = -1;
        property = property.substring(1);
    }
    return (a: T, b: T): number => {
        const valueA = (a as Record<string, unknown>)[property] as number;
        const valueB = (b as Record<string, unknown>)[property] as number;
        const result = valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
        return result * sortOrder;
    };
}

/**
 * Bring a phone number to the configured length: too short is padded with non-breaking spaces,
 * too long is shortened and the last digit replaced by an `x` (only for pure numbers).
 */
export function numberFormat(number: string, length: number, align?: 'r', log?: ioBroker.Logger): string {
    const onlyNumbers = /\D+/g;
    if (!number.match(onlyNumbers)) {
        // pure digits: shorten and mark the number as shortened
        if (number.length > length) {
            number = `${number.substring(0, length - 1)}x`;
        }
    }
    // numbers that are still too long are cut to the wanted length
    number = number.substring(0, length);
    if (align !== 'r') {
        number = number + fill(length - number.length);
    } else {
        number = fill(length - number.length) + number;
    }

    let i = 0;
    while (number.search(' ') >= 0) {
        // replace all normal spaces by utf-8 non-breaking spaces
        number = number.replace(' ', NBSP);
        if (!i) {
            log?.debug(`Leerzeichen gegen utf-8 non breaking space ersetzt: <${number}>`);
        }
        i++;
        if (i > 40) {
            log?.warn(`function numberFormat: zu langer Sting: ${number}`);
            break;
        }
    }
    return number;
}

/** Test for a valid international phone number starting with `+` */
export function validateE164(value: string, log?: ioBroker.Logger): boolean {
    const regex = /^\+(?:[0-9] ?){6,14}[0-9]$/;
    if (regex.test(value)) {
        return true;
    }
    log?.warn(`${value} is not a vail int. phone number. Please check your configuration (Country + Area Code).`);
    return false;
}

/**
 * Convert an external phone number into the E.164 format, e.g. `4711321` becomes `+492114711321`
 * for the country code 49 and the area code 211.
 */
export function e164(extrnr: string, cc: string, ac: string, unknownNumber: string, log?: ioBroker.Logger): string {
    // keep the digits only
    extrnr = extrnr.toString().replace(/\D+/g, '');
    if (extrnr === unknownNumber) {
        return extrnr;
    }
    if (extrnr.length > 0) {
        let extrnr0 = 0;
        for (let i = 0; i < extrnr.length; i++) {
            // `substring(i, 2 * i + 1)` is the original `substr(i, i + 1)`: from the second
            // position on this compares more than one character and therefore stops the loop.
            // Changing it would change the E.164 number of every caller with leading zeros.
            if (extrnr.substring(i, 2 * i + 1) !== '0') {
                break;
            }
            extrnr0++;
        }
        extrnr = extrnr.slice(extrnr0, extrnr.length);

        if (extrnr0 === 0) {
            extrnr = `+${cc}${ac}${extrnr}`;
        }
        if (extrnr0 === 1) {
            extrnr = `+${cc}${extrnr}`;
        }
        if (extrnr0 === 2) {
            extrnr = `+${extrnr}`;
        }

        validateE164(extrnr, log);
    }
    return extrnr;
}

/** Build a dialable `tel:` link. `formattedNumber` is shown instead of the E.164 number if given. */
export function telLink(number: string, formattedNumber?: string): string {
    if (!formattedNumber) {
        return `<a style="text-decoration: none;" href="tel:${number}">${number}</a>`;
    }
    return `<a style="text-decoration: none;" href="tel:${number}">${formattedNumber}</a>`;
}

/** `dd.mm. hh:mm` of a FRITZ!Box date, padded with non-breaking spaces for the tables */
export function fritzboxDateToTableDate(fritzboxDate: string): string {
    const month = fritzboxDate.substring(3, 5);
    const day = fritzboxDate.substring(0, 2);
    const hour = fritzboxDate.substring(9, 11);
    const minute = fritzboxDate.substring(12, 14);
    return `${day}.${month}.${NBSP}${hour}:${minute}${NBSP}${NBSP}`;
}

/**
 * Duration in seconds formatted to a string of 7 characters:
 *
 * - `      -` = 0 sec.
 * - `      5` = one digit second
 * - `     27` = two digit seconds
 * - `   1:41` = one digit minutes
 * - `  59:32` = two digit minutes
 * - `8:21:44` = more than an hour, less than 10 h
 * - `  >10 h` = more than 10 h
 */
export function durationForm(duration: string | number): string {
    if (duration === '') {
        return fill(7);
    }
    let durationMin = Math.floor(parseInt(String(duration), 10) / 60);
    const durationSek = parseInt(String(duration), 10) % 60;
    const durationStd = Math.floor(durationMin / 60);
    durationMin %= 60;

    let text: string;
    if (durationStd < 1) {
        if (durationMin < 1) {
            text = String(durationSek);
        } else {
            text = `${durationMin}:${fill(2 - durationSek.toString().length, '0')}${durationSek}`;
        }
    } else {
        // the seconds are padded with non-breaking spaces instead of `0` here - `fill(n, 0)`
        // falls back to the default padding because `0` is falsy. Kept as it was.
        text = `${durationStd}:${fill(2 - durationMin.toString().length, '0')}${durationMin}:${fill(2 - durationSek.toString().length, 0)}${durationSek}`;
    }

    if (text === '0') {
        text = '-';
    }
    if (text.length > 7) {
        text = '> 10h';
    }
    return fill(7 - text.length) + text;
}

/** Join the entries of a call list to one HTML block */
export function getEventsList(list: string[]): string {
    let text = '';
    for (let i = 0; i < list.length; i++) {
        text += `${text ? '<br>\n' : ''}${list[i]}`;
    }
    return text;
}

/**
 * Insert `line` at the top of `list`, limit the list to `howManyLines` entries and render it.
 * `list` is modified in place, it keeps the entries between two calls.
 */
export function makeList(
    list: string[],
    line: string,
    headline: string,
    howManyLines: number,
    showHeadline: boolean,
): string {
    let lines = 0;
    if (showHeadline === true) {
        list.shift(); // remove the old headline
        list.unshift(headline, line); // headline and the new entry become the first two entries
        lines = 1;
    } else {
        list.unshift(line);
    }

    if (list.length > howManyLines + lines) {
        list.length = howManyLines + lines;
    }
    return getEventsList(list);
}
