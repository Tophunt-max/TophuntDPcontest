export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto max-w-4xl p-8 bg-white dark:bg-boxdark rounded-lg shadow-sm">
      <h1 className="text-3xl font-bold mb-6 text-black dark:text-white">Privacy Policy</h1>
      <p className="text-sm text-gray-500 mb-8">Last Updated: October 2023</p>
      
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">1. Information We Collect</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          We collect information you provide directly to us, such as your name, email, phone number, and profile picture when you create an account.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">2. How We Use Your Information</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          We use your information to operate our contests, provide customer support, and send you important updates about your account and our services.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">3. Data Sharing</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          We do not sell your personal information. We may share data with service providers who help us operate the app (like image storage or SMS services).
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">4. Data Security</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          We implement industry-standard security measures to protect your personal information from unauthorized access or disclosure.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">5. Your Rights</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          You can request to access, update, or delete your personal information at any time through your account settings or by contacting our support team.
        </p>
      </section>
    </div>
  );
}
