---
name: TaskRelay
description: A quiet Chinese personal workbench for tasks, execution evidence, and human assistance.
colors:
  primary: "#146b5e"
  primary-foreground: "#fff"
  background: "#fff"
  foreground: "#253836"
  secondary: "#f1f4f3"
  muted: "#657470"
  accent: "#e8f2ee"
  border: "#dce3df"
  canvas: "#f7f8f6"
  navigation: "#f0f3ef"
  navigation-selected: "#dfeae1"
  navigation-selected-ink: "#185d47"
  placeholder: "#596a64"
  ring: "#167366"
  positive: "#226b4d"
  positive-surface: "#e7f3ec"
  waiting: "#815812"
  waiting-surface: "#fff0d2"
  failed: "#a54436"
  failed-surface: "#fceae7"
  challenge-surface: "#fff8e9"
  challenge-border: "#ead9b4"
  challenge-ink: "#78541e"
  destructive: "#ad3a31"
typography:
  headline:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.55
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.55
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  body-compact:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.55
  metadata:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.55
  control:
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "calc(1.25 / 0.875)"
rounded:
  md: "7px"
  lg: "10px"
  xl: "14px"
  navigation: "8px"
  panel: "12px"
  pill: "calc(infinity * 1px)"
spacing:
  utility-unit: "0.25rem"
  compact: "8px"
  control: "12px"
  form: "16px"
  section: "20px"
  panel: "24px"
  settings: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0.25rem 0.75rem"
    height: "2.25rem"
  navigation-selected:
    backgroundColor: "{colors.navigation-selected}"
    textColor: "{colors.navigation-selected-ink}"
    rounded: "{rounded.navigation}"
    padding: "12px 14px"
  status-waiting:
    backgroundColor: "{colors.waiting-surface}"
    textColor: "{colors.waiting}"
    rounded: "{rounded.pill}"
    padding: "3px 7px"
  panel:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
  challenge:
    backgroundColor: "{colors.challenge-surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "17px"
---

# Design System: TaskRelay

## Overview

**Creative North Star: "Quiet personal workbench"**

TaskRelay uses warm white surfaces, dark green text, muted green navigation, and restrained amber assistance states. The shared website and Electron interface is compact and task-oriented: hierarchy comes from readable Chinese labels, precise spacing, selection, and explicit execution status. This name describes the existing code-led workbench; it is not a newly approved visual concept.

This record captures the implementation in `packages/ui/src/styles.css`, `app.tsx`, `task-editor.tsx`, `settings.tsx`, `conversation.tsx`, and the generated shadcn/ui primitives. `PRODUCT.md` supplies the durable Chinese UI and shared-client commitments; `docs/surfaces/workspace.md` owns the surface strategy. The reviewed desktop, phone, narrow-window, model-dialog, task-editor, generated-schedule, and unknown-result captures are local demonstrations labelled “演示”. They do not establish real execution outcomes.

The finish verdict in `.impeccable/review/finish-verdict.md` resolves six scored fixes only. There is no approved visual comp, decision comp, or QUALITY BAR card, and no claim of comp fidelity or completed seeded concept approval. This document does not certify backend reliability, real-provider integration, native-machine acceptance, or every required product state. The light theme is the implemented visual system; generated dark variants are not a completed TaskRelay dark theme.

**Key Characteristics:**
- Warm white panels with green ink and thin, quiet boundaries.
- Compact Chinese operating text with localized status and action labels.
- Adjacent task and conversation views that become explicit list/detail navigation on narrow screens.
- Amber assistance and uncertain-result states, always accompanied by text.
- Named fields, visible keyboard focus, and bounded, scrollable dialogs.

## Colors

The palette is a muted green workbench with warm neutral grounds; amber and red communicate state rather than decoration. Frontmatter values preserve the source CSS and are normative for this record. The sidecar's eight-step OKLCH ramps are synthesized preview metadata, not additional colors used by the application.

### Primary

- **Deep relay green** (`primary`): primary actions, active tab underlines, brand symbol, checkbox accent, and general keyboard outline.
- **White on green** (`primary-foreground`): text and icons on primary actions.
- **Pale green accent** (`accent`): hover treatment for outline and ghost buttons and the welcome mark.
- **Green focus ring** (`ring`): generated control focus borders and translucent rings.

### Secondary

- **Positive green** (`positive`, `positive-surface`): running, active, and succeeded badges share this pair; their text distinguishes the state.
- **Waiting amber** (`waiting`, `waiting-surface`): waiting-for-user and unknown-result badges. Amber does not imply success.
- **Challenge amber** (`challenge-surface`, `challenge-border`, `challenge-ink`): current human-assistance block, its boundary, icon, and title. The workspace assistance banner uses its own related amber treatment in source.
- **Failure red** (`failed`, `failed-surface`): failed-run badges. `destructive` is the generated control invalid-state color; it is not the default treatment for ordinary cancellation.

### Neutral

- **Warm canvas** (`canvas`) surrounds white (`background`) content panels.
- **Green-black ink** (`foreground`) carries primary text; `muted` carries secondary explanations and metadata.
- **Soft field neutral** (`secondary`) is the generated secondary/muted utility role.
- **Quiet boundary** (`border`) separates rows, panels, tabs, and forms.
- **Navigation ground** (`navigation`) and its selected surface/ink pair separate persistent navigation from task content.
- **Readable prompt ink** (`placeholder`) overrides input and textarea placeholder color. The finish review measured it above 4.5:1 on the white, secondary, and reply-composer surfaces it checked; that is not a whole-interface contrast certification.

**The Text-and-State Rule.** Every execution badge includes a localized state label; the dot and color reinforce that label.

## Typography

**Body and interface font:** Segoe UI, Microsoft YaHei, sans-serif. There is no separate display font or editorial type system. Time and code use tabular numerals; ordinary Chinese labels retain normal case and tracking.

The hierarchy is compact rather than a mathematical modular scale. The root is the frontmatter body role; many practical descriptions use body-compact or smaller supporting text. Native system typography is recorded for this operating interface, not promoted to a display-heading rule for unrelated surfaces.

### Hierarchy

- **Headline:** page heading role from frontmatter; at the narrow and phone breakpoints it reduces to 23 px and 20 px respectively. Phone headings use a 1.5 line-height and a 14 ch maximum width.
- **Title:** detail and settings section headings. The global h2 baseline is 18 px; these recurring sections override it to the title role.
- **Body:** baseline Chinese interface text and inherited form font. Generated Tailwind rem dimensions resolve against the actual 14 px root, so a `2.25rem` control is not a 36 px control here.
- **Body compact:** descriptions, chat content, and challenge instructions. Explanatory blocks may increase line-height to 1.75–1.8.
- **Label:** named form labels and permissions legends. Button text uses the separate control role from the generated primitive.
- **Metadata:** secondary run, task, and field information. Some existing timestamps/citations are 10 px; these are observed small metadata, not a recommended size for task instructions or primary controls.

Long prose, task titles, evidence URLs, and structured output wrap rather than widen the page. Task-row descriptions deliberately clamp to two lines, while the selected task exposes full content.

## Layout

The desktop shell is a sticky full-height navigation column (204 px) and a flexible workspace. The workspace is capped at 1740 px, with 36/42/40 px top/horizontal/bottom padding. The task panel uses adjacent columns, `minmax(280px, 0.83fr)` and `minmax(340px, 1.17fr)`, with a 620 px minimum height. A single border contains the rows and detail view; it is not a stack of individually elevated task cards.

| Source breakpoint | Implemented change |
| --- | --- |
| At or below 1200 px | Navigation becomes 170 px; workspace padding becomes 28 px by 25 px; task columns become `minmax(250px, 0.8fr)` and `minmax(310px, 1.2fr)`. |
| At or below 950 px | Navigation becomes a 72 px icon rail. Task selection replaces the list with detail, and an explicit return action appears. Workspace padding is 26 px by 22 px. |
| At or below 600 px | Navigation becomes a sticky horizontal top bar. Workspace padding is 25 px by 16 px; action groups wrap; forms become one column; run rows use two columns and hide the desktop header. |

The document supports a minimum body width of 320 px. At desktop and narrow widths, conversation content has a bounded scroll area (640 px, then 540 px); phones remove that content-height cap. Form fields stack with a 7 px internal gap and 17 px bottom margin; paired fields use a 16 px gap before collapsing on phones. Common layout spacing is recorded in frontmatter without forcing every value into a uniform scale.

Dialogs have internal vertical scrolling and a viewport-bound maximum height: `calc(100dvh - 40px)`, changing to `calc(100dvh - 24px)` on phones. Phone dialog width is `calc(100vw - 24px)`; task editors permit a 720 px maximum width. The generated shadcn dialog also retains its 40 rem `sm` maximum-width/header-alignment behavior. Keep these source rules together rather than treating the task-editor maximum as a new responsive breakpoint.

**The Explicit Return Rule.** When a selected task replaces the list, retain the visible “返回任务列表” action; do not depend on an invisible gesture.

## Elevation & Depth

The application is mostly flat. White panels, tinted selections, thin dividers, and restrained status surfaces establish hierarchy. Generated outline buttons and fields use a small control shadow; the dialog is the deliberate elevated layer. Cards and task rows do not gain floating shadows on hover.

### Shadow Vocabulary

- **Control edge** (`0 1px 2px 0 rgb(0 0 0 / 0.05)`): installed Tailwind `shadow-xs` used by generated outline buttons, inputs, textareas, and switches. The reply textarea explicitly removes this shadow.
- **Dialog lift** (`0 15px 60px rgb(22 49 35 / 0.17)`): TaskRelay dialog override, over a `rgb(30 49 40 / 0.3)` overlay.
- **Keyboard focus:** the unlayered global rule gives focus-visible controls a 2 px primary outline with a 3 px offset. Generated controls also specify a ring-color border and a 3 px translucent ring. Their layered `outline-none` utility does not override the global focus rule; preserve the resulting visible focus rather than assuming only one treatment applies.

State transitions come from generated controls: the installed Tailwind default is 150 ms with `cubic-bezier(0.4, 0, 0.2, 1)`. Loading icons use a one-second linear rotation. The global reduced-motion rule reduces animation and transition durations to 0.01 ms. Generated dialog markup contains fade/zoom classes, but this stylesheet does not import their animation utility package; their presence alone is not evidence of a working dialog entrance animation.

## Shapes

Controls use the medium corner token; navigation and grouped permissions use a slightly wider 8 px curve. Tinted summaries and message bubbles use the large corner token. Main task, run, settings, and challenge panels use the 12 px panel token, while dialogs and the welcome container use the extra-large token. Badges and small state dots are rounded; iconography comes from Lucide SVGs.

Borders are generally one pixel. Tab selection uses a two-pixel lower edge, not a new filled tab container. Panels clip their own row boundaries; long text wraps inside its column. Do not generalize the compact state dot into an icon substitute for actions.

## Components

### Buttons

Generated official shadcn/ui primitives carry interaction states; TaskRelay uses default, outline, and ghost buttons in the inspected flows. Primary green marks create, save, run, and send actions; outline is used for secondary operations; ghost is used for quieter cancellation or auxiliary actions. Default size and padding are in frontmatter; a button with a direct SVG child reduces horizontal padding to 0.75 rem. Small buttons are 2 rem high and icon buttons are square.

Primary hover applies 90% primary opacity; outline and ghost hover use the pale accent and primary text. Disabled controls reduce opacity and block interaction. Busy actions pair disabled state with a rotating loader. Icon-only send and navigation controls retain accessible names. The library's additional destructive, secondary, and link variants exist but are not established as recurring TaskRelay action patterns by these screens.

### Chips and status

Status uses the generated badge plus a small same-color dot and an explicit Chinese label. Running/active/succeeded share green; waiting_user/unknown share amber; failed is red; remaining states use the neutral badge treatment. These are informational badges, not filter controls. Do not give a static badge fake hover or click behavior.

### Cards and rows

Task lists, settings, and run records use white bordered containers. Task rows are full-width buttons with a bottom divider; hover is a light green wash and selection is a stronger pale green wash. Detail content is separated by headers and rules. Run summaries use a quiet tinted inset; chat messages use separate pale tones for user and system content. The sidecar's panel sample illustrates the container, not a new standalone card interaction.

### Inputs and fields

Fields use visible wrapping labels and optional supporting text, generated inputs/textareas, and native selects. Selects have a 37 px fixed height, white background, and medium corners. Textareas permit vertical resizing; the reply composer has a 64 px minimum height, soft background, no border, and no shadow at rest. Prompts use the corrected placeholder color. Errors appear in localized `role="alert"` blocks; preserve the message, not only an invalid border.

Task draft generation updates the visible schedule kind, expression, timezone, and one-time value before saving. Allowed-site editing retains raw line breaks; normalization happens at save. These are established form conventions: displayed controls must represent the values that will be submitted. Model API-key fields are password inputs and clear after submission attempts; that behavior is not evidence that every sensitive form has the same lifecycle.

### Navigation and tabs

Main navigation uses buttons with `aria-label` and `aria-current="page"`, so hidden labels on the icon rail and phone navigation retain accessible names. Task-detail and settings tabs have one selected tab in keyboard order, Left/Right wrapping navigation, Home/End, stable IDs, `aria-controls`, and a labelled tab panel. The current tab is a primary-colored underline with stronger text. Preserve those semantics if their visual composition changes.

### Human assistance and execution evidence

The amber assistance action selects the relevant task/run and explicitly returns the detail view to the conversation, even if the same task was already selected. The challenge includes the exact instruction, expiry, and scoped-use explanation; optional verification images have descriptive alt text. Submission clears the reply immediately. Answered, consuming, and unsupported challenges disable repeated input; answered/consuming displays “已回复，正在核验”.

Each run state has its own no-summary fallback. Unknown results retain the account-lock explanation and “只读核查结果” action. Never replace a terminal or unknown state with generic ongoing-execution copy. Evidence quotations and URLs remain visible in the summary; missing usage and cost show “未知”. These are observed presentation semantics, not a claim that an external task actually succeeded.

### Dialogs and settings

Dialogs use Radix-backed focus containment, a labelled title/description, and a close control named “关闭”. Long task and model forms scroll internally; the footer remains in the form's DOM order. Settings share the same tab and field system. Desktop-only executor controls appear only when the desktop transport is present; the shared website does not imitate those local capabilities.

## Do's and Don'ts

### Do:

- **Do** keep status text beside the color and dot, including unknown and failed outcomes.
- **Do** preserve visible labels, keyboard focus, and the existing tab/panel relationships.
- **Do** keep a narrow-screen return action when task detail replaces the list.
- **Do** let long task content and evidence wrap within their containers.
- **Do** keep the displayed schedule and multiline website fields faithful to the submitted values.
- **Do** identify synthetic review fixtures as “演示” and keep their results distinct from live execution evidence.

### Don't:

- **Don't** report an unknown, failed, cancelled, or expired run as still executing.
- **Don't** replace the conversation's current challenge with a browser-takeover affordance.
- **Don't** add a working dark-theme, approved-comp, or complete-accessibility claim on the basis of generated classes or these captures.
- **Don't** reuse the smallest timestamp/citation text for task instructions or main controls.
- **Don't** turn flat task rows into individually shadowed floating cards; the current container and dividers supply their hierarchy.
- **Don't** treat this implementation record or the six-fix ship verdict as native, backend, or real-provider acceptance.
