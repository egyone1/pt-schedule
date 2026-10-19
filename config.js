// Firebase web config (public by design - access is controlled by firestore.rules).
// Leave apiKey empty to run the site in local demo mode.
export const firebaseConfig = {
  apiKey: "AIzaSyDcU1cTEVS_Fd3ZjDceGhPJzA-j49Y4Oh8",
  authDomain: "cleo-pt-schedule.firebaseapp.com",
  projectId: "cleo-pt-schedule",
  appId: "1:222869543580:web:983629ad6888e2796dab59",
};

// Only this account can edit after a doctor submits or after the day is closed.
export const ADMIN_EMAIL = "admin@cleo-pt-schedule.app";
