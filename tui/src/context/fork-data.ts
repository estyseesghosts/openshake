/**
 * OpenShake's fork boundary for the client data layer. Everything except `createData`
 * comes from the published package unchanged; the streaming and residency fixes live
 * in `client-data.ts` so this project can carry them without a monorepo checkout.
 */
export * from "@opencode/client/solid"
export { createData } from "./client-data"
