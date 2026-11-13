import {
  dailyLimitReached,
  getUsage,
  recordAIRequest,
  recordAIRequestFailed,
  recordAIRequestStarted,
  resetUsage,
} from '../usage';
const mockValues = new Map<string, unknown>();
jest.mock('@utils/mmkv/mmkv', () => ({
  getMMKVObject: (key: string) => mockValues.get(key),
  setMMKVObject: (key: string, value: unknown) => mockValues.set(key, value),
}));

beforeEach(() => {
  mockValues.clear();
  resetUsage();
});

it('counts failed generation attempts against the daily allowance', () => {
  recordAIRequestStarted();
  recordAIRequestFailed();
  expect(getUsage()).toMatchObject({
    requests: 1,
    requestsFailed: 1,
    requestsToday: 1,
  });
  expect(dailyLimitReached(1)).toBe(true);
});

it('does not double-count a successful response or invent token usage', () => {
  recordAIRequestStarted();
  recordAIRequest(100, 50, null);
  expect(getUsage()).toMatchObject({
    requests: 1,
    requestsToday: 1,
    inputChars: 100,
    outputChars: 50,
    hasTokenData: false,
  });
});
