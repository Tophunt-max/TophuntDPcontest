// Every `require` here is bundled into the app (and every OTA update) whether or
// not anything renders it, so list only images read through this object. Others
// are required directly where they are used. Removed 2026-10-26 because nothing
// read them: liveBg.png (2.8 MB), post.png, userDark.png, music.png, musicTone.png.
export default {
  onBoardingLight1: require('./onBordingLight1.webp'),
  onBoardingLight2: require('./onBordingLight2.webp'),
  onBoardingLight3: require('./onBordingLight3.webp'),
  userLight: require('./userLight.png'),
  tophuntLogo: require('./Tophunt.webp'),
};
