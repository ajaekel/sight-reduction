# Roadmap

## Add autofill

* [X] Add button to retrieve data with USNO API call
* [X] Add option to cache almanac data for a date or range of dates
* [ ] Option to autofill altitude corrections (via direct computation) see pg 280 in Nautical Almanac
  * [ ] Option to replace Dip with Observer altitude above sea level (The user should still have the option to enter Dip if they're working wth an Almanac offline)
  * [ ] Refraction
  * [ ] Semi-diameter for Sun/Moon/planets, where applicable
  * [ ] Parallax, particularly for the Moon

## Add educational functionality

* [ ] Make the “black box” more transparent
* [ ] Add tooltip explanations for each field
* [ ] Add option to expose the formulas behind calculated fields

## Extend functionality to cover multiple sightings

* [ ] Support multiple sightings in a session
* [ ] Add bisectors / multi-LOP fix
* [ ] Add running fix; accept inputs for SOG and bearing

## Miscellaneous

* [X] Add a searchable drop-down option for “Star Name”, in section 1; Do not restrict input to the predefined names. Free-form entry is intentionally allowed for.

* [ ] Calculate sunset for the AP

  * [ ] Include a note indicating how many minutes after sunset the sighting occurred

* [X] Add to JSON export:

  * [X] `observationTimeUTC`
  * [X] `Ho`

* [ ] Change “Label / Notes (optional, helps you find this sight later)” to “Notes (observed bearing, visibility, etc...)”

  * [ ] This field should no longer factor into the filename upon saving Stop notes from replacing the default name upon “Save to Device”
  * [ ] Refactor code for clarity; rename `label` to `notes`, `sightLabel` to `sightNotes`, etc...

* [X] Give the user an option to rename the file from the default name upon “Save Sight to Device"

* [ ] If Celestial Body is `Sun` or `Moon`, add new field `Limb` (dropdown options: `lower` (default), `upper`)

  * [ ] Make the placement/size of "Celestial Body" steady. Make "Date (local)" just wide enought to comfortably display the selected date and keep it at that size. There should be blank space to the right of "Celestial Body" which will get populated with either `Limb` or `Name`.

* [ ] Restructure the Assumed Postion section to occupy less realestate. Add a label "Assumed Position" below which the screen is split into two columns each "column" has its own header "Latitude" and "Longitude", each with fields for "Deg / Min / N-S" (similar to how Sun > Declination is rendered in section "3. Nautical Almanac Data").

##  Bugs

* [X] Fix mobile display of Section 3 → Declination (overflows off right of screen)
        Ensure that the three veritcal separation lines [between a) the header, highlghted blue that displays the time/date , b) GHA and c) Declination] are all aligned

* [ ] Data fetch from USNO fails on cellular data, only works on wifi, should have option to download data over cellular

# Completed

## Add charting

* [X] Visualize the Assumed Position, Azimuth to celestial body and LOP