# Roadmap

## Support passage

* [X] Chronological record of navigation
* [X] Add plot

## Support full-screen plotting (Desktop mode)

* [X] Develop feature for Fix plot:
  * [X] Zoom in/out
  * [ ] Collapsible control panels
  * [ ] Adjust visualization variables
  * [ ] Background layer selection: map, satellite
* [X] Enable for Sight plot
* [X] Enable for DR Leg plot 
* [X] Enable for Passage and make actionable – create/edit navigation elements from plot

## Support remaining navigational elements

* [X] Known Fix – position coordinate and datetime from any source, e.g., via VHF radio from a passing ship
  * [ ] Add optional Notes field to Known Fix for provenance/confidence/context.
* [X] Meridian Passage – User enters sextant height (+corrections) and gets Latitude
  * [ ] If included in a Fix, modify plot legend notes to remove " — Zn 180° (0.0 nm TOWARD)" – irrelevant to a noon sight

## Planning page

* [X] Sunset/sunrise for the AP
* [ ] For the Moon, include it's percentage, i.e., from "new" to "full"
* [ ] Add a data point to Sights, how many minutes after/before sunset/sunrise/meridian passage of Sun/Moon

## Autofill vs Manual modes

* [X] Add button to retrieve data with USNO API call
* [X] Add option to cache almanac data for a date or range of dates
* [ ] Autofill position
* [ ] Option to autofill altitude corrections (via direct computation) see pg 280 in Nautical Almanac
  * [ ] Option to replace Dip with Observer altitude above sea level (The user should still have the option to enter Dip if they're working wth an Almanac offline)
  * [ ] Refraction
  * [ ] Semi-diameter for Sun/Moon/planets, where applicable
  * [ ] Parallax, particularly for the Moon
* Make display of Altitude Correction fields conditional on context
  * [ ] Don't display `Add'l Corr.` if not relevant.
  * [ ] Ensure all labeling and presence of all necessary corrections for Moon Sight

## Educational functionality

* [ ] Make the “black box” more transparent
* [ ] Add tooltip explanations for each field
* [ ] Add option to expose the formulas behind calculated fields
* [ ] Option to show intermediate calculations
* [ ] Evolve the app to be an educational aid

## Data management page

* [ ] User can see how many MBs per data type (Almanac Data, sights, fixes, other?)
* [ ] User can selectively delete cached data
* [ ] Make cached-vs-network data status visually obvious
* [ ] Show size by data type: Almanac data, Sights, Fixes, etc...
* [ ] Document/ensure responsible API usage

## Settings page

* [ ] units, e.g., DMS vs decimal, knots vs mph, etc...
* [ ] Manual vs Online mode
* [ ] Default values: timezone, position, clock error, filename format
* Operating modes

    #### Manual / Offline

    - [ ] Never automatically retrieve almanac data
    - [ ] User enters almanac values manually
    - [ ] User can override cached values

    #### Online / Data Saver

    - [ ] Use cached data when available
    - [ ] Offer download when data is missing
    - [ ] Clearly indicate whether required data is cached

    #### Online / Automatic

    - [ ] Use cached data when available
    - [ ] Automatically download missing data
    - [ ] Option to ignore/refresh cached data

## UX/UI improvements

* [ ] Establish consistent defaulting rules for date/time/timezone/position fields.
* [ ] Make lat/lon position rendition consistent (outliers: Passages > New, Fixes > New Known Fix)
* [ ] Put star SHA and declination on the same line
* [ ] Make single-touch and consist the treatment of fields for selecting N/S, E/W, fast/slow, on/off the arc, +/(-)
* [ ] Put a char limit on all input fields (A user shouldn’t be able to enter an arbitrarily large string; test, can it crash the app if abused?)  
* [ ] Improve "Sights" page and replicate for all saved navigation elements: Fixes, DR Legs, Passages
  * [ ] Move actions to a "overflow menu", `⋮`: load, edit, duplicate, rename, delete
  * [ ] Enable common table actions: sort, filter
  * [ ] Allow multi-select and replication ovlerflow menu actions at with menu bar buttons
  * [ ] Batch actions: import, export, delete

## Offline reliability

- [ ] Test all core workflows with no network
- [ ] Test with cached almanac data
- [ ] Test with no cached data
- [ ] Test manual Almanac entry
- [ ] Test transition between online/offline states
- [ ] Fix references must survive sight edits/imports/deletes appropriately

## Traditional-method comparison

Potential future feature: **the app eliminates the arithmetic/table lookup without hiding the navigation method.**

- [ ] Show the equivalent traditional Nautical Almanac / Sight Reduction Tables workflow alongside the automated calculation

##  Bugs
(none)

---

# Completed

## Support multiple sights

* [X] Support multiple sights in a session
* [X] Add bisectors / multi-LOP fix
* [X] Add DR Leg
* [X] Add running fix; accept inputs for SOG and bearing

## Other

* [X] Change “Label / Notes (optional, helps you find this sight later)” to “Notes (observed bearing, visibility, etc...)”

  * [X] This field should no longer factor into the filename upon saving Stop notes from replacing the default name upon “Save to Device”
  * [X] Refactor code for clarity; rename `label` to `notes`, `sightLabel` to `sightNotes`, etc...

* [X] If Celestial Body is `Sun` or `Moon`, add new field `Limb` (dropdown options: `lower` (default), `upper`)

  * [X] Make the placement/size of "Celestial Body" steady. Make "Date (local)" just wide enought to comfortably display the selected date and keep it at that size. There should be blank space to the right of "Celestial Body" which will get populated with either `Limb` or `Name`.

* [X] Restructure the Assumed Postion section to occupy less realestate. Add a label "Assumed Position" below which the screen is split into two columns each "column" has its own header "Latitude" and "Longitude", each with fields for "Deg / Min / N-S" (similar to how Sun > Declination is rendered in section "3. Nautical Almanac Data").

* [X] Fix mobile display of Section 3 → Declination (overflows off right of screen)
        Ensure that the three veritcal separation lines [between a) the header, highlghted blue that displays the time/date , b) GHA and c) Declination] are all aligned

* [X] Add a searchable drop-down option for “Star Name”, in section 1; Do not restrict input to the predefined names. Free-form entry is intentionally allowed for.

* [X] Give the user an option to rename the file from the default name upon “Save Sight to Device"

* [X] Add to JSON export:

  * [X] `observationTimeUTC`
  * [X] `Ho`

* [X] Add charting: Visualize the Assumed Position, Azimuth to celestial body and LOP

## Bugs

* [X] Data fetch from USNO fails on cellular data, only works on wifi, should have option to download data over cellular

* [X] If user loads a sight and edit it and resaves with a new name, it overwrites the original sight (User should be able to load a sight to use as the base for another, e.g., avoid needing to manually enter the AP again and again for a multi-star stationary fix)
Expected behavior, if a sight is saved and renamed, it's saved as a new sight
