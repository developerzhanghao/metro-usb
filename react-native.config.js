// iOS only: there is nothing to link on Android (use `adb reverse` there).
module.exports = {
  dependency: {
    platforms: {
      android: null,
    },
  },
};
