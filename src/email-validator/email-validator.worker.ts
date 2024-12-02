import { parentPort, workerData, threadId } from 'worker_threads';
import axios from 'axios';

const API_URL =
  'https://readytosend-api-production.up.railway.app/verify-email';
const MAX_RETRIES = 3;

async function validateEmail(email: string, retries = 0): Promise<any> {
  console.log(`[Worker ${threadId}] Processing email: ${email}`);
  try {
    const response = await axios.get(`${API_URL}?email=${email}`, {
      timeout: 10000,
    });
    console.log(`[Worker ${threadId}] Successfully validated: ${email}`);
    return {
      email,
      status: response.data.email_status,
      mx: response.data.email_mx,
      provider: response.data.provider,
    };
  } catch (error) {
    console.error(
      `[Worker ${threadId}] Error validating ${email}: ${error.message}`,
    );
    if (retries < MAX_RETRIES) {
      const delay = Math.min(Math.pow(2, retries) * 1000, 5000);
      console.log(`[Worker ${threadId}] Retrying after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return validateEmail(email, retries + 1);
    }
    return {
      email,
      status: 'invalid',
      mx: 'error',
      provider: 'error',
    };
  }
}

async function processEmails(emails: string[]) {
  console.log(
    `[Worker ${threadId}] Started processing ${emails.length} emails`,
  );
  const results = await Promise.all(
    emails.map((email) => validateEmail(email)),
  );
  console.log(
    `[Worker ${threadId}] Completed processing batch of ${emails.length} emails`,
  );
  parentPort?.postMessage(results);
}

if (parentPort) {
  console.log(
    `[Worker ${threadId}] Worker initialized with ${workerData.emails.length} emails`,
  );
  processEmails(workerData.emails);
}
