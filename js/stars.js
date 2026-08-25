/**
 * stars.js
 * The standard ~57 navigational stars (the set found in the Nautical
 * Almanac's star pages), used only to power suggestions in the Star Name
 * autocomplete on Section 1. This is a convenience list, not a validation
 * list -- the Star Name field never restricts input to these names, since
 * the user may legitimately not know a body's name yet and want to type
 * something else entirely (e.g. a bearing or a note to fill in later).
 */
(function (global) {
  'use strict';

  global.NAV_STARS = [
    'Acamar', 'Achernar', 'Acrux', 'Adhara', 'Al Na\'ir', 'Aldebaran', 'Alioth',
    'Alkaid', 'Alnilam', 'Alphard', 'Alphecca', 'Alpheratz', 'Altair', 'Ankaa',
    'Antares', 'Arcturus', 'Atria', 'Avior', 'Bellatrix', 'Betelgeuse', 'Canopus',
    'Capella', 'Deneb', 'Denebola', 'Diphda', 'Dubhe', 'Elnath', 'Eltanin',
    'Enif', 'Fomalhaut', 'Gacrux', 'Gienah', 'Hadar', 'Hamal', 'Kaus Australis',
    'Kochab', 'Markab', 'Menkar', 'Menkent', 'Miaplacidus', 'Mirfak', 'Nunki',
    'Peacock', 'Polaris', 'Pollux', 'Procyon', 'Rasalhague', 'Regulus',
    'Rigel', 'Rigil Kentaurus', 'Sabik', 'Schedar', 'Shaula', 'Sirius',
    'Spica', 'Suhail', 'Vega', 'Zubenelgenubi'
  ].sort();
})(window);
