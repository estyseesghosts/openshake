import { createData } from "./fork-data"
import { withMediaRefs, type LocationRef } from "@opencode/client"
import { CliRenderEvents } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useConfig } from "../config"

export { locationKey } from "@opencode/client/solid"
export type { FormWithLocation } from "@opencode/client/solid"

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: { directory: string }) => {
    const client = useClient()
    const config = useConfig()
    const renderer = useRenderer()
    // Publish accumulated stream content at most once per rendered frame. The
    // renderer is asked to draw when a delta arrives; lifecycle events still flush
    // synchronously inside the client data layer, so no final payload is delayed.
    const frameFlushes = new Set<() => void>()
    const drainFrameFlushes = () => {
      const due = [...frameFlushes]
      frameFlushes.clear()
      due.forEach((flush) => flush())
    }
    renderer.on(CliRenderEvents.FRAME, drainFrameFlushes)
    onCleanup(() => renderer.off(CliRenderEvents.FRAME, drainFrameFlushes))
    const data = createData({
      // Only the transcript store reads stored media as `media:<hash>` refs; plugins and other callers keep inline bytes.
      api: () => withMediaRefs(client.api),
      event: client.event,
      connection: client.connection,
      directory: props.directory,
      // Live tool results share the bounded blob pool with server media refs, so
      // image previews never keep base64 payloads inside transcript messages.
      media: client.media,
      // Live tool events carry screenshots as inline base64, which open tabs would otherwise hold for the whole run.
      // Read per event, so toggling previews applies to new results without a restart.
      omitToolFileData: () => !config.data.session?.image_preview,
      flushStream: (flush) => {
        frameFlushes.add(flush)
        renderer.requestRender()
      },
    })
    // Turning previews on brings back the screenshots dropped while they were off.
    createEffect(
      on(
        () => config.data.session?.image_preview === true,
        (preview) => {
          if (preview) void data.session.message.restoreFiles()
        },
        { defer: true },
      ),
    )
    data satisfies Plugin.Context["data"]
    const [generatingTitles, setGeneratingTitles] = createStore<Record<string, boolean | undefined>>({})
    return {
      ...data,
      location: {
        ...data.location,
        async sync(ref?: LocationRef) {
          await data.location.syncInfo(ref)
          await Promise.all([data.location.sync(ref), data.location.config.sync(ref)])
        },
      },
      session: {
        ...data.session,
        title: {
          pending: (sessionID: string) => generatingTitles[sessionID] === true,
          async generate(sessionID: string) {
            if (generatingTitles[sessionID]) return
            setGeneratingTitles(sessionID, true)
            await client.api.session
              .update({ sessionID, title: "" })
              .then(() => {
                // The HTTP response can beat the renamed event. Keep pending until the new title is projected locally.
                data.session.invalidate(sessionID)
                return data.session.sync(sessionID)
              })
              .finally(() => setGeneratingTitles(sessionID, undefined))
          },
        },
      },
    }
  },
})
