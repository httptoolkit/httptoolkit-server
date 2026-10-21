export * from './runtime';
import { main } from './runtime';

if (require.main === module) {
    main().catch(error => { console.error(error); process.exit(1); });
}
