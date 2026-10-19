// Firebase web config (public by design - access is controlled by firestore.rules).
// Leave apiKey empty to run the site in local demo mode.
export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  appId: "",
};

// Only this account can edit after a doctor submits or after the day is closed.
export const ADMIN_EMAIL = "admin@cleo-pt-schedule.app";
