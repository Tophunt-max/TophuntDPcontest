export default function TermsOfServicePage() {
  return (
    <div className="mx-auto max-w-4xl p-8 bg-white dark:bg-boxdark rounded-lg shadow-sm">
      <h1 className="text-3xl font-bold mb-6 text-black dark:text-white">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-8">Last Updated: October 2023</p>
      
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">1. Acceptance of Terms</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          By accessing and using TopHunt DP Contest, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our services.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">2. User Accounts</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          You are responsible for maintaining the confidentiality of your account information. You must be at least 15 years old to create an account. All activities under your account are your responsibility.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">3. Contest Rules</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          Users must only upload original content. Any form of cheating, bot usage, or harassment will lead to immediate account suspension and forfeiture of prizes.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">4. Intellectual Property</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          By uploading content, you grant TopHunt a non-exclusive license to use, display, and promote your content within the platform. You retain ownership of your original work.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4 text-black dark:text-white">5. Termination</h2>
        <p className="text-body-color dark:text-dark-6 leading-relaxed">
          We reserve the right to terminate or suspend access to our service immediately, without prior notice, for conduct that we believe violates these Terms.
        </p>
      </section>
    </div>
  );
}
