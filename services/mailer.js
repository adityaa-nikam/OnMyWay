const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
    } else {
      // Development console transporter: logs magic link directly to terminal
      transporter = {
        sendMail: async (mailOptions) => {
          console.log('\n=================== 📨 ONMYWAY (OMW) MAGIC LINK ===================');
          console.log(`To: ${mailOptions.to}`);
          console.log(`Subject: ${mailOptions.subject}`);
          console.log(`\nLink: ${mailOptions.text.match(/https?:\/\/[^\s]+/)?.[0] || mailOptions.text}`);
          console.log('====================================================================\n');
          return { messageId: 'dev_mock_' + Date.now() };
        }
      };
    }
  }
  return transporter;
}

async function sendMagicLinkEmail({ to, magicLinkUrl }) {
  const mail = getTransporter();
  const mailOptions = {
    from: process.env.MAIL_FROM || '"OnMyWay (OMW)" <noreply@onmyway.local>',
    to,
    subject: 'Sign in to OnMyWay (OMW) — Share until you arrive',
    text: `Hello!\n\nClick the link below to sign in to OnMyWay:\n\n${magicLinkUrl}\n\nThis single-use link expires in 15 minutes.\nIf you did not request this email, you can safely ignore it.`,
    html: `
      <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background: #0f172a; color: #f8fafc; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1);">
        <h2 style="color: #38bdf8; margin-top: 0;">⚡ OnMyWay (OMW)</h2>
        <p style="color: #94a3b8; font-size: 0.95rem;">Share until you arrive.</p>
        <p style="margin: 20px 0; color: #cbd5e1;">Click below to confirm your sign-in request:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${magicLinkUrl}" style="background: #0284c7; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Confirm Sign In</a>
        </div>
        <p style="color: #64748b; font-size: 0.8rem; margin-top: 24px;">This single-use link expires in 15 minutes. If you did not request this email, you can safely ignore it.</p>
      </div>
    `
  };

  return mail.sendMail(mailOptions);
}

module.exports = { sendMagicLinkEmail };
