// HTML for the Telegram Mini App dashboard. Imported as a text module
// so we can keep it as a clean .html file (with normal template literals
// usable inside the inline <script>).
import html from './static/app.html';

export const APP_HTML: string = html as unknown as string;
