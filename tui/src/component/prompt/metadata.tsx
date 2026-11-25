import { RGBA, TextAttributes, type BoxRenderable, type MouseEvent } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export function PromptMetadataRow(props: {
  mode: "normal" | "shell"
  agent?: string
  auto: boolean
  model: string
  provider: string
  variant?: string
  /** The model's selected speed; unset at its standard speed. */
  speed?: string
  /** What the workspace's limits leave for the model, once it is running low. */
  limit?: { readonly text: string; readonly danger: boolean }
  /** Right-aligned token context readout, e.g. "14.1K (45%)". */
  context?: string
  onModelClick?: () => void
  onVariantClick?: () => void
  muted: boolean
  highlight: RGBA
  agentAlpha: number
  modelAlpha: number
  variantAlpha: number
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [modelHovered, setModelHovered] = createSignal(false)
  const [variantHovered, setVariantHovered] = createSignal(false)
  // The row's own width once laid out: beside the session tabs the prompt is narrower than the terminal.
  const [measured, setMeasured] = createSignal<number>()
  const layout = createMemo(() => {
    if (props.mode === "shell") return { agent: props.agent ?? "Shell", model: "" }
    return promptMetadataLayout({
      width: measured() ?? Math.max(0, dimensions().width - (dimensions().width < 44 ? 9 : 13)),
      terminalWidth: dimensions().width,
      agent: props.agent ?? "",
      auto: props.auto,
      model: props.model,
      provider: props.provider,
      variant: props.variant,
      speed: props.speed,
      limit: props.limit?.text,
      context: props.context,
    })
  })
  const modelColor = () => (props.muted ? theme.text.muted : theme.text.base)
  const variantColor = () => theme.text.feedback.warning.base
  // A click must not fire while the reader is selecting text in the prompt.
  const onClick = (run: (() => void) | undefined) => (event: MouseEvent) => {
    if (event.button !== 0 || renderer.getSelection()?.getSelectedText()) return
    event.stopPropagation()
    run?.()
  }

  return (
    <box
      flexDirection="row"
      gap={1}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      onSizeChange={function (this: BoxRenderable) {
        setMeasured(this.width)
      }}
    >
      <Show
        when={(props.mode === "shell" || props.agent) && (layout().agent || layout().model)}
        fallback={<box height={1} />}
      >
        <Show when={layout().agent}>
          {(agent) => <text fg={fade(props.highlight, props.agentAlpha)}>{agent()}</text>}
        </Show>
        <Show when={props.mode === "normal" && layout().auto}>
          <text fg={fade(theme.text.muted, props.agentAlpha)}>auto</text>
        </Show>
        <Show when={props.mode === "normal" && layout().model}>
          <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Show when={layout().agent}>
              <text fg={fade(theme.text.muted, props.modelAlpha)}>·</text>
            </Show>
            <text
              flexShrink={1}
              minWidth={0}
              wrapMode="none"
              truncate
              fg={modelHovered() ? modelColor() : fade(modelColor(), props.modelAlpha)}
              onMouseOver={() => setModelHovered(true)}
              onMouseOut={() => setModelHovered(false)}
              onMouseUp={onClick(props.onModelClick)}
            >
              {layout().model}
            </text>
            <Show when={layout().provider}>
              {(provider) => (
                <text
                  flexShrink={1}
                  minWidth={0}
                  wrapMode="none"
                  truncate
                  fg={fade(theme.text.muted, props.modelAlpha)}
                >
                  {provider()}
                </text>
              )}
            </Show>
            <Show when={layout().variant}>
              {(variant) => (
                <>
                  <text flexShrink={0} fg={fade(theme.text.muted, props.variantAlpha)}>
                    ·
                  </text>
                  <text
                    flexShrink={1}
                    minWidth={0}
                    wrapMode="none"
                    truncate
                    fg={variantHovered() ? variantColor() : fade(variantColor(), props.variantAlpha)}
                    attributes={TextAttributes.BOLD}
                    onMouseOver={() => setVariantHovered(true)}
                    onMouseOut={() => setVariantHovered(false)}
                    onMouseUp={onClick(props.onVariantClick)}
                  >
                    {variant()}
                  </text>
                </>
              )}
            </Show>
            <Show when={layout().speed}>
              {(speed) => (
                <>
                  <text flexShrink={0} fg={fade(theme.text.muted, props.modelAlpha)}>
                    ·
                  </text>
                  <text flexShrink={0} fg={fade(props.muted ? theme.text.muted : theme.text.base, props.modelAlpha)}>
                    {speed()}
                  </text>
                </>
              )}
            </Show>
            <Show when={layout().limit ? props.limit : undefined}>
              {(limit) => (
                <text
                  flexShrink={0}
                  marginLeft={1}
                  wrapMode="none"
                  fg={fade(limit().danger ? theme.text.feedback.error.base : theme.text.muted, props.modelAlpha)}
                >
                  {limit().text}
                </text>
              )}
            </Show>
          </box>
        </Show>
      </Show>
      <Show when={props.context}>
        {(context) => (
          <text flexShrink={0} wrapMode="none" fg={fade(theme.text.muted, props.modelAlpha)}>
            {context()}
          </text>
        )}
      </Show>
    </box>
  )
}

function fade(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

type Layout = {
  agent?: string
  auto?: boolean
  model: string
  provider?: string
  variant?: string
  speed?: string
  limit?: string
}

export function promptMetadataLayout(input: {
  width: number
  terminalWidth: number
  agent: string
  auto?: boolean
  model: string
  provider: string
  variant?: string
  speed?: string
  limit?: string
  context?: string
}) {
  // The context readout is anchored on the right, so it reserves width from the shrinking fields.
  const available = Math.max(0, input.width - (input.context ? stringWidth(input.context) + 1 : 0))
  const narrow = input.terminalWidth < 44
  const agent = narrow ? undefined : input.agent
  const provider = input.provider
  const providerLast = provider.split(" / ").at(-1) ?? provider
  const variant = input.variant
  const selection = { speed: input.speed, limit: input.limit }

  // On narrow terminals keep both fields visible in shortened form rather than dropping them outright.
  const providers: (string | undefined)[] = narrow
    ? [Locale.truncateWidth(provider, 8), undefined]
    : [provider, providerLast, undefined]
  const variants: (string | undefined)[] = narrow
    ? [variant ? Locale.truncateWidth(variant, 5) : undefined, undefined]
    : [variant, undefined]
  const autos = input.auto ? [true, false] : [false]

  const candidates: Layout[] = []
  for (const auto of autos) {
    for (const candidateProvider of providers) {
      for (const candidateVariant of variants) {
        candidates.push({
          agent,
          auto: auto || undefined,
          model: input.model,
          provider: candidateProvider,
          variant: candidateVariant,
          ...selection,
        })
      }
    }
  }
  const fit = candidates.find((candidate) => stringWidth(text(candidate)) <= available)
  if (fit) return fit

  // Nothing fits: keep the model readable and let flex truncation shorten the remaining fields.
  const fallbackProvider = narrow ? Locale.truncateWidth(provider, 8) : undefined
  const fallbackVariant = narrow && variant ? Locale.truncateWidth(variant, 5) : variant
  const prefix = agent ? `${agent} · ` : ""
  const suffix = `${fallbackVariant ? ` · ${fallbackVariant}` : ""}${input.speed ? ` · ${input.speed}` : ""}${
    input.limit ? `  ${input.limit}` : ""
  }`
  const providerWidth = fallbackProvider ? stringWidth(fallbackProvider) + 1 : 0
  return {
    agent,
    model: Locale.truncateWidth(
      input.model,
      Math.max(9, available - stringWidth(prefix) - providerWidth - stringWidth(suffix)),
    ).replace(/\s+…$/, "…"),
    provider: fallbackProvider,
    variant: fallbackVariant,
    ...selection,
  }
}

function text(input: Layout) {
  return [
    ...(input.agent ? [input.agent] : []),
    ...(input.auto ? ["auto"] : []),
    ...(input.model ? [...(input.agent ? ["·"] : []), input.model] : []),
    ...(input.provider ? [input.provider] : []),
    ...(input.variant ? ["·", input.variant] : []),
    ...(input.speed ? ["·", input.speed] : []),
    ...(input.limit ? [` ${input.limit}`] : []),
  ].join(" ")
}
