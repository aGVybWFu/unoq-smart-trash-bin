# Design System: Smart Sort Console
**Project ID:** smart-sort-dashboard

## 1. Visual Theme & Atmosphere
The design atmosphere is **"Precision Backend Console."** It mimics professional developer tools (like Vercel or GitHub). It is highly functional, dense but structured, and data-forward. It replaces rounded, bubbly aesthetics with sharp, utilitarian efficiency. The mood is crisp, technical, and reliable. 

## 2. Color Palette & Roles
* **Base Background** (`#f9fafb`): The outermost canvas. Extremely light gray to reduce eye strain compared to pure white.
* **Surface Card** (`#ffffff`): For foreground containers and data cards. Crisp and clean.
* **Border Subtle** (`#e5e7eb`): Very light borders used extensively to separate layout zones.
* **Text Primary** (`#111827`): Deep almost-black for high legibility on headings and core data.
* **Text Muted** (`#6b7280`): Mid-gray for secondary info, timestamps, and axis labels.
* **Primary Accent (Azure)** (`#0070f3`): Sharp, electric blue used for active states, links, and primary actions.
* **Success Emerald** (`#10b981`): Used for "Paper Cup" category and heat map contributions.
* **Warning Amber** (`#f59e0b`): Used for "Plastic" category and alert states.
* **Danger Red** (`#ef4444`): Used for destructive actions (Reset/Delete).
* **Heatmap Scales**:
  * Level 0: `#ebedf0`
  * Level 1: `#9be9a8`
  * Level 2: `#40c463`
  * Level 3: `#30a14e`
  * Level 4: `#216e39`

## 3. Typography Rules
* **Global Font**: `Inter`, `-apple-system`, `sans-serif`. Designed for extreme legibility at small sizes.
* **Monospaced Numbers**: For all data points, counters, and table data, use `tabular-nums` so numbers align perfectly vertically.
* **Headings**: `600` weight (Semi-Bold), compact tracking (`-0.02em`).
* **Micro-copy**: Size `12px`, uppercase with wide tracking for section labels.

## 4. Component Stylings
* **Cards/Containers**: Minimalist geometry. Subtly rounded corners (`6px` or `8px`), thin 1px borders, and **no drop shadows** (or extremely subtle whisper shadows).
* **Buttons**: Functional and crisp. Slight hover background changes. Active state depresses slightly.
* **Inputs/Forms**: Strict borders (`1px solid #e5e7eb`), clear focus rings (`ring-2 ring-blue-500`).
* **Tabs/Navigation**: Clean underlines or segmented control pills. Active tabs get high contrast text, inactive tabs remain muted.

## 5. Layout Principles
* **Structure**: A fixed sidebar or top navigation, with a responsive main content area.
* **Whitespace Strategy**: Structured density. Elements inside a card are tightly grouped (`8px` gap), but cards themselves are separated by generous structural margins (`24px`).
* **Alignment**: Strict grid alignment. Everything aligns to a column or row. No floating or centered content unless it's an empty state.
