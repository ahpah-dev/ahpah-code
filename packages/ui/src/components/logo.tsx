import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        data-slot="logo-logo-mark-shadow"
        d="M12 8H4V4H12V8ZM12 20H4V12H12V20Z"
        fill="var(--icon-weak-base)"
      />
      <path
        data-slot="logo-logo-mark-o"
        d="M4 4V8H12V4H4ZM16 20H12V12H4V20H0V0H16V20Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M60 40H20V20H60V40ZM60 100H20V60H60V100Z" fill="var(--icon-base)" />
      <path d="M20 20V40H60V20H20ZM80 100H60V60H20V100H0V0H80V100Z" fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 270 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        {/* a (0..24) */}
        <path d="M18 18H0V12H18V18ZM18 30H6V24H18V30Z" fill="var(--icon-weak-base)" />
        <path d="M24 36H0V18H18V12H0V6H24V36ZM6 24V30H18V24H6Z" fill="var(--icon-base)" />
        {/* h (30..54) */}
        <path d="M48 36H36V18H48V36Z" fill="var(--icon-weak-base)" />
        <path d="M36 0V12H54V36H48V18H36V36H30V0H36Z" fill="var(--icon-base)" />
        {/* p (60..84) */}
        <path d="M78 30H66V18H78V30Z" fill="var(--icon-weak-base)" />
        <path d="M66 30H78V12H66V30ZM84 36H66V42H60V6H84V36Z" fill="var(--icon-base)" />
        {/* a (90..114) */}
        <path d="M108 18H90V12H108V18ZM108 30H96V24H108V30Z" fill="var(--icon-weak-base)" />
        <path d="M114 36H90V18H108V12H90V6H114V36ZM96 24V30H108V24H96Z" fill="var(--icon-base)" />
        {/* h (120..144) */}
        <path d="M138 36H126V18H138V36Z" fill="var(--icon-weak-base)" />
        <path d="M126 0V12H144V36H138V18H126V36H120V0H126Z" fill="var(--icon-base)" />
        {/* c (156..180) */}
        <path d="M180 30H162V18H180V30Z" fill="var(--icon-weak-base)" />
        <path d="M180 12H162V30H180V36H156V6H180V12Z" fill="var(--icon-strong-base)" />
        {/* o (186..210) */}
        <path d="M204 30H192V18H204V30Z" fill="var(--icon-weak-base)" />
        <path d="M204 12H192V30H204V12ZM210 36H186V6H210V36Z" fill="var(--icon-strong-base)" />
        {/* d (216..240) */}
        <path d="M234 30H222V18H234V30Z" fill="var(--icon-weak-base)" />
        <path d="M234 12H222V30H234V12ZM240 36H216V6H234V0H240V36Z" fill="var(--icon-strong-base)" />
        {/* e (246..270) */}
        <path d="M270 24V30H252V24H270Z" fill="var(--icon-weak-base)" />
        <path d="M252 12V18H264V12H252ZM270 24H252V30H270V36H246V6H270V24Z" fill="var(--icon-strong-base)" />
      </g>
    </svg>
  )
}
