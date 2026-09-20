/// <reference types="vite/client" />

/** The four knobs that decide whether this build talks to a laptop or to AWS.
 *  All absent = the local backend through Vite's proxy. See src/lib/cloud.ts. */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_WS_BASE?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_REGION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
