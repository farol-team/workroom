/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKROOM_SERVER?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
