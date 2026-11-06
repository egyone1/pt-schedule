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
// Department accounts: statistics, comparison and download for their own department only (no editing).
// The admin sets their passwords on the site; firestore.rules lets in only the accounts the admin created.
export const VIEWERS = {
  outpatient: { label: "Outpatient", email: "outpatient@cleo-pt-schedule.app", depts: ["outpatient"] },
  inpatient: { label: "Inpatient", email: "inpatient@cleo-pt-schedule.app", depts: ["inpatient"] },
  aqua: { label: "Aqua", email: "aqua@cleo-pt-schedule.app", depts: ["aqua"] },
  others: { label: "Others", email: "others@cleo-pt-schedule.app", depts: null },   // every other department
};
