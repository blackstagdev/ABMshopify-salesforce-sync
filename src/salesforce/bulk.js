// Salesforce Bulk API 2.0 ingest: one job per CSV. A job costs a handful of
// API calls (create, upload, close, polls, results) however many rows it has.
import { parseCsv } from '../csv.js';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBulk(sf, { pollMs = 15_000, sleep = sleepMs, log = () => {} } = {}) {
  // Returns { jobId, ok, failed }: ok rows carry sf__Id and sf__Created,
  // failed rows sf__Error, each with the columns that were sent.
  async function run({ object, operation, externalIdFieldName, csv }) {
    const { data: job } = await sf.request('POST', '/jobs/ingest', {
      object,
      operation,
      contentType: 'CSV',
      lineEnding: 'LF',
      ...(externalIdFieldName && { externalIdFieldName }),
    });
    await sf.request('PUT', `/jobs/ingest/${job.id}/batches`, csv, { contentType: 'text/csv' });
    await sf.request('PATCH', `/jobs/ingest/${job.id}`, { state: 'UploadComplete' });

    let info;
    for (;;) {
      await sleep(pollMs);
      ({ data: info } = await sf.request('GET', `/jobs/ingest/${job.id}`));
      if (['JobComplete', 'Failed', 'Aborted'].includes(info.state)) break;
      log(`    ${object} job ${job.id}: ${info.state}, ${info.numberRecordsProcessed ?? 0} rows done...`);
    }
    if (info.state !== 'JobComplete') {
      throw new Error(`Bulk ${operation} of ${object} (job ${job.id}) ${info.state}: ${info.errorMessage ?? 'no message'}`);
    }

    const ok = parseCsv((await sf.request('GET', `/jobs/ingest/${job.id}/successfulResults/`, undefined, { raw: true })).data ?? '');
    const failed = parseCsv((await sf.request('GET', `/jobs/ingest/${job.id}/failedResults/`, undefined, { raw: true })).data ?? '');
    return { jobId: job.id, ok, failed };
  }

  return { run };
}
