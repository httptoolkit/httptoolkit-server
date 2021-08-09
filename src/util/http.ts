// In some places (Docker proxy) we use req.rawHeaders plus this logic to capture a
// usable header object that doesn't normalize headers to e.g. combine duplicates and
// lowercase names.
export function rawHeadersToHeaders(rawHeaders: string[]) {
    return rawHeaders.reduce((result, next, i) => {
        if (i % 2 === 0) {
            const existingValue = result[next];
            if (typeof existingValue === 'string') {
                result[next] = [existingValue];
            }
        } else {
            const key = rawHeaders[i - 1];
            const existingValue = result[key];
            if (Array.isArray(existingValue)) {
                existingValue.push(next);
            } else {
                result[key] = next;
            }
        }
        return result;
    }, {} as { [key: string]: string | string[] | undefined });
}