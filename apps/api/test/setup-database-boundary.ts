import { assertApiTestDatabaseBoundary } from './fixtures/api-test-database-boundary';

assertApiTestDatabaseBoundary(process.env, { required: false });
