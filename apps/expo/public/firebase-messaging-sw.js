importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

const firebaseConfig = {
  apiKey: "AIzaSyDTNJOrXA1bIyUTKozhuDw7wKdzYZrn2D8",
  authDomain: "tophuntdpcontest.firebaseapp.com",
  projectId: "tophuntdpcontest",
  storageBucket: "tophuntdpcontest.firebasestorage.app",
  messagingSenderId: "1055570975270",
  appId: "1:1055570975270:web:cff6347dab76bb104b24e7"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/favicon.png', // Fallback to favicon if specific icons missing
    badge: '/favicon.png',
    data: payload.data
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
