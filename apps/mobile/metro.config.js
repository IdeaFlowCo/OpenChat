// Minimal metro config that extends Expo's default.
// Required by expo-doctor (otherwise EAS Build fails the doctor check on local builds).
// Added 2026-06-02 after build 46 attempt hit this gate.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
