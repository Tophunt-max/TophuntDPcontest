const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://buhun-tophunt.firebaseio.com'
});

const auth = admin.auth();
const db = admin.firestore();

const createUserAndMakeAdmin = async (email, password) => {
    try {
        // Create user
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            emailVerified: true,
            disabled: false
        });

        console.log('Successfully created new user:', userRecord.uid);

        // Set admin claims
        await auth.setCustomUserClaims(userRecord.uid, { role: 'admin' });

        // Create user document in Firestore
        await db.collection('users').doc(userRecord.uid).set({
            email: email,
            role: 'admin'
            // Add other user fields as needed
        });

        console.log(`Successfully made ${email} an admin.`);

    } catch (error) {
        console.error('Error creating user and making admin:', error);
    }
};

const [email, password] = process.argv.slice(2);

if (!email || !password) {
    console.log('Please provide an email and password.');
    process.exit(1);
}

createUserAndMakeAdmin(email, password);
