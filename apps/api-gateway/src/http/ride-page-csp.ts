/**
 * The ride page's Content-Security-Policy. Its pictures come from Google Maps and, for the driver's photo
 * (signed links), from our own R2 host and no other: https://<account>.r2.cloudflarestorage.com, never a wildcard.
 */
const GOOGLE_MAPS_HOSTS = "https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com";

/** The host the signed photo links use (the S3 endpoint of DriverKycStorage); null when R2 is not configured. */
export function r2PhotoHost(accountId: string | undefined): string | null {
  const id = accountId?.trim();
  return id && /^[A-Za-z0-9-]+$/.test(id) ? `https://${id}.r2.cloudflarestorage.com` : null;
}

export function ridePageCsp(accountId: string | undefined): string {
  const r2 = r2PhotoHost(accountId);
  return `default-src 'self'; script-src 'self' ${GOOGLE_MAPS_HOSTS} blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; ` +
    // Google Maps only (no Leaflet tiles) and no socket: the ride page polls over HTTPS.
    `img-src 'self' data: blob: ${GOOGLE_MAPS_HOSTS}${r2 ? ` ${r2}` : ''}; connect-src 'self' ${GOOGLE_MAPS_HOSTS} data: blob:; ` +
    `frame-src *.google.com; worker-src blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
}
