import { createUniqueId, type ComponentProps } from "solid-js"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 270 42"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            {/* a */}
            <path pathLength={props.outline ? 1 : undefined} d="M24 36H0V18H18V12H0V6H24V36ZM6 24V30H18V24H6Z" />
            {/* h */}
            <path pathLength={props.outline ? 1 : undefined} d="M36 0V12H54V36H48V18H36V36H30V0H36Z" />
            {/* p */}
            <path pathLength={props.outline ? 1 : undefined} d="M66 30H78V12H66V30ZM84 36H66V42H60V6H84V36Z" />
            {/* a */}
            <path pathLength={props.outline ? 1 : undefined} d="M114 36H90V18H108V12H90V6H114V36ZM96 24V30H108V24H96Z" />
            {/* h */}
            <path pathLength={props.outline ? 1 : undefined} d="M126 0V12H144V36H138V18H126V36H120V0H126Z" />
            {/* c */}
            <path pathLength={props.outline ? 1 : undefined} d="M180 12H162V30H180V36H156V6H180V12Z" />
            {/* o */}
            <path pathLength={props.outline ? 1 : undefined} d="M204 12H192V30H204V12ZM210 36H186V6H210V36Z" />
            {/* d */}
            <path pathLength={props.outline ? 1 : undefined} d="M234 12H222V30H234V12ZM240 36H216V6H234V0H240V36Z" />
            {/* e */}
            <path pathLength={props.outline ? 1 : undefined} d="M252 12V18H264V12H252ZM270 24H252V30H270V36H246V6H270V24Z" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="270" height="42">
          <rect width="270" height="42" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="135" y1="22" x2="135" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
