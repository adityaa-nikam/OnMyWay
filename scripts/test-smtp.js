try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // .env is optional
}

const { getTransporter, sendMagicLinkEmail } = require('../services/mailer');

async function main() {
  console.log('Testing SMTP configuration...');
  console.log('-----------------------------');
  console.log(`SMTP_HOST:    ${process.env.SMTP_HOST || '(not set)'}`);
  console.log(`SMTP_PORT:    ${process.env.SMTP_PORT || '(not set, default 587)'}`);
  console.log(`SMTP_SERVICE: ${process.env.SMTP_SERVICE || '(not set)'}`);
  console.log(`SMTP_USER:    ${process.env.SMTP_USER || '(not set)'}`);
  console.log(`SMTP_PASS:    ${process.env.SMTP_PASS ? '********' : '(not set)'}`);
  console.log('-----------------------------\n');

  if (!process.env.SMTP_USER || (!process.env.SMTP_HOST && !process.env.SMTP_SERVICE)) {
    console.log('⚠️  No SMTP credentials found in .env or environment.');
    console.log('Please set SMTP_USER and SMTP_PASS in your .env file.');
    process.exit(1);
  }

  const transporter = getTransporter();

  try {
    console.log('Verifying SMTP connection...');
    await transporter.verify();
    console.log('✅ SMTP connection and authentication successful!\n');
  } catch (err) {
    console.error('❌ SMTP verification failed:');
    console.error(err.message);
    if (err.message.includes('Username and Password not accepted') || err.message.includes('Invalid login') || err.message.includes('Authentication failed') || err.message.includes('535')) {
      console.log('\n💡 Tip for Brevo:');
      console.log('1. Verify your SMTP_USER is your exact Brevo login email address.');
      console.log('2. Ensure SMTP_PASS is the master SMTP key from https://app.brevo.com/settings/keys/smtp (starts with xsmtpsib-...)');
      console.log('\n💡 Tip for Gmail:');
      console.log('1. Ensure 2-Step Verification is enabled on your Google Account.');
      console.log('2. Generate a 16-character App Password at: https://myaccount.google.com/apppasswords');
      console.log('3. Put that 16-character password into SMTP_PASS in .env (without spaces).');
    }
    process.exit(1);
  }

  const targetEmail = process.argv[2];
  if (targetEmail) {
    console.log(`Sending test magic link email to: ${targetEmail}...`);
    try {
      const result = await sendMagicLinkEmail({
        to: targetEmail,
        magicLinkUrl: `${process.env.APP_URL || 'http://localhost:3000'}/auth/verify?token=test_token_sample`
      });
      console.log('✅ Email sent successfully!');
      console.log('Message ID:', result.messageId || result);
    } catch (sendErr) {
      console.error('❌ Failed to send email:', sendErr.message);
      process.exit(1);
    }
  } else {
    console.log('💡 Tip: Pass an email address to send a real test email, e.g.:');
    console.log('   node scripts/test-smtp.js your-email@example.com\n');
  }
}

main();
