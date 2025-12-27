
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from apps/admin/.env.local
const envPath = path.join(__dirname, '..', '.env.local');
dotenv.config({ path: envPath });

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
// The private key needs newlines to be correctly parsed
const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

// Initialize Firebase Admin SDK only once
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });
  console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
  if (error.code !== 'app/duplicate-app') {
    console.error("Firebase Admin SDK initialization error:", error);
    process.exit(1);
  }
  console.log("Firebase Admin SDK was already initialized.");
}


async function checkDatabase(dbId) {
  console.log(`\nChecking Firestore database: '${dbId}'...`);
  try {
    // Get a reference to the specific Firestore database
    const db = getFirestore(admin.app(), dbId);
    
    // Test connectivity by listing collections
    const collections = await db.listCollections();
    console.log(`Successfully connected to '${dbId}'.`);
    if (collections.length === 0) {
      console.log("No collections found in this database.");
    } else {
      console.log(`Collections in '${dbId}':`, collections.map(c => c.id));
    }
    return true;
  } catch (error) {
    console.error(`Error checking '${dbId}':`, error.message);
    if (error.code === 5) { // gRPC 'NOT_FOUND' error code
        console.error(`Specific Error: The database with ID '${dbId}' was not found in project '${projectId}'. Please ensure it has been created in the Firebase console.`);
    }
    return false;
  }
}

async function run() {
  // Check the 'dpcontest' database as specified in the project files
  await checkDatabase('dpcontest');
  process.exit();
}

run();
