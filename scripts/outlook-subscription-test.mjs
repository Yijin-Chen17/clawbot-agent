import http from 'node:http';

const calendar = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Calcury//Outlook Subscription Test//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Calcury Subscription Test',
  'BEGIN:VEVENT',
  'UID:outlook-test-20261124@calcury-test',
  'DTSTAMP:20261123T120000Z',
  'DTSTART:20261124T110000Z',
  'DTEND:20261124T120000Z',
  'SUMMARY:Calcury subscription test',
  'DESCRIPTION:This is a test calendar event.',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

if (process.argv.includes('--print')) {
  process.stdout.write(calendar);
} else {
  http.createServer((req, res) => {
    if (req.url !== '/outlook-subscription-test.ics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(calendar);
  }).listen(18765, '127.0.0.1', () => {
    console.log('http://127.0.0.1:18765/outlook-subscription-test.ics');
  });
}
