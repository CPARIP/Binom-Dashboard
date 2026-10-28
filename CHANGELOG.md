# Changelog

## 0.6.13

- The "Exclude bots" checkbox no longer breaks the main chart with the "Binom repeated a report page" error: days and hours without clicks are shown as empty points, and totals are calculated from the data received.
- "Exclude bots" also applies to "Recent clicks": clicks that Binom marked as bots are not shown. If the API user has the "Bot" column turned off, the log reports that the filter cannot be applied.
- Cost and ROI are read from the `cost` field returned by Binom v2 (`costs` remains as a fallback).
- The period, custom dates, group, source and overview checkboxes are kept when navigating Dashboard → Campaigns → Dashboard.
- A campaign with no traffic for the period is shown with zeros when Binom explicitly returns zero totals; ratios (CR, EPC, CPC, ROI) remain "—".
- An empty click log says "There are no clicks for this period, or they are unavailable." instead of reporting a format error.
- In "Traffic composition", entries that exist only in the previous period are labeled separately.
- A custom period loads once, after you finish entering the dates; a zero previous-period value is shown in the metric's format.
- Opening Dashboard no longer builds the panel twice; on a Campaigns page without a search field, the panel is not re-created.
- From this version on, after the extension is updated or reloaded, open Binom tabs get Dashboard without a page reload. When updating from 0.6.12 or earlier, reload open Binom tabs once; until then they keep the previous copy, so Dashboard is never shown twice.
- The Binom-style design is now more compact, with a new metric palette for the light and dark themes; the settings page and the extension icon menu are styled the same way. Only one design remains, and the extension does not change the styling of the tracker's sections.

## 0.6.12

- Interface language selection in the extension menu: English / Русский, English by default.
- The "Devices" dimension was removed from the traffic composition; the device is still shown in the click log.

## 0.6.11

- Country flag for The Netherlands.
- EPC and CPC are shown with four decimal places; fixed the CR axis label in comparison mode.

## 0.6.10

- Binom-style settings page, without unnecessary headings and captions.
- Removed the always-visible explanations about unique clicks and the appended notes in chart tooltips.

## 0.6.9

- "Unique clicks" uses the same Binom Unique Clicks metric in all modes; the toggle setting is kept when switching modes.

## 0.6.8

- The checkbox was renamed to "Unique clicks" and placed before "Exclude bots"; if the metric is missing, the hint names the Binom column that is needed.

## 0.6.7

- "Uniques" checkbox: the clicks card, chart, period comparison and traffic composition use Binom unique clicks.
- The time zone is no longer entered manually: it is read from Binom settings when you connect or unlock the key.

## 0.6.6

- Resetting filters keeps the current tab.

## 0.6.5

- Fixed recognition of rows in the "Devices" dimension.
- The chart can no longer be collapsed.

## 0.6.4

- A "Campaigns" tab in traffic composition: the ten largest campaigns and a gray "Others" segment.
- Selecting a campaign, group or source hides the corresponding composition tab.
- The group field comes before the campaign selector.
- Normal scrolling over the chart scrolls the page; Ctrl + mouse wheel zooms the chart.

## 0.6.3

- Full-width traffic composition with a donut chart; the separate top campaigns block was removed.
- The overview opens with the last 30 days.
- New default set and order of columns for recent clicks.

## 0.6.2

- Campaign selection by group: groups are collapsed, and search covers the entire catalog.

## 0.6.1

- The click log supports numeric values and lists; added a "Country" column.
- Country, device and OS icons with the full label on hover.
- A "Reset filters" button.

## 0.6.0

- Customizable cards for ten Binom metrics, including CR, EPC, CPC and bots.
- Single-campaign selection in the overview with period comparison; the chart's time step is chosen automatically.
- A recent clicks log with a choice of columns and page size.

## 0.5.0

- Extension icon menu: design choice, turning Dashboard on and off, and a link to settings.
- Binom-style design for all dashboard blocks.

## 0.4.2

- Support for `entity_id` identifiers and categories without an ID in Binom reports.
- A "Today and yesterday" block with the click difference as of the same time of day.
- Heatmap tooltips; a shared left scale for counts and ROI.

## 0.4.1

- Reports for a large number of campaigns are loaded in batches.
- The dashboard moved into a separate container; if an error occurs, the native interface remains.
- Custom dropdown menus with keyboard control.

## 0.4.0

- Additional analytics blocks and saved campaign selections.
- Saving the API key with password-based encryption.
- The palette follows Binom's built-in light/dark theme switch.

## 0.3.0

- The "Dashboard" item is placed in the main menu before Campaigns.

## 0.2.0

- A separate dashboard page inside the Binom shell.
- Comparison of up to eight campaigns on one chart.

## 0.1.1

- Fixed a false "incomplete report data" rejection when the API repeated the full time series.

## 0.1.0

- First release: metric cards and an interactive chart based on Binom v2 Public API data, with no changes to files on the server.
