-- What each saved WhatsApp message was (text, buttons, list, form, link, image, reaction, template, location). Expand only.
ALTER TABLE "WhatsappMessage" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
