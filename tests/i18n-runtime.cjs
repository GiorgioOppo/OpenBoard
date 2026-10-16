// Existing feature tests exercise the Italian source language. Localization has
// a separate suite that uses the same runtime with all seven locales.
const {create} = require('../web/i18n.js');
const instance = create({locale:'it'});
module.exports = {tr:instance.t,ui:instance.html,OpenBoardI18n:instance};
