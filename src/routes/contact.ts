import { Router, Request, Response } from 'express';
import logger from '../lib/logger';
import emailService from '../services/email.service';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  const { email, lang } = req.body as { email?: string; lang?: string };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email' });
    return;
  }

  try {
    await emailService.sendRawEmail({
      to: 'radwan.arbane@gmail.com',
      subject: `[TableNow] Nouveau lead — ${email}`,
      html: `<p>Nouveau contact depuis le widget <strong>TableNow Concierge</strong>.</p>
             <p><strong>Email :</strong> ${email}</p>
             <p><strong>Langue :</strong> ${lang ?? 'fr'}</p>`,
      text: `Nouveau contact depuis le widget TableNow Concierge.\nEmail : ${email}\nLangue : ${lang ?? 'fr'}`,
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'contact email error');
    res.status(500).json({ error: 'Failed to send email' });
  }
});

export default router;
