import { readDir } from '../index';
import { list } from '../request';
jest.mock('../request', () => ({ list: jest.fn(), create: jest.fn() }));

it('passes Drive pageToken as a parameter and retains all pages', async () => {
  jest
    .mocked(list)
    .mockResolvedValueOnce({
      files: [{ id: 'one' }],
      nextPageToken: 'page-2',
    } as never)
    .mockResolvedValueOnce({ files: [{ id: 'two' }] } as never);
  const files = await readDir('parent');
  expect(files.map(file => file.id)).toEqual(['one', 'two']);
  expect(list).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      pageToken: 'page-2',
      q: expect.not.stringContaining('pageToken'),
    }),
  );
});

it('rejects a repeating page token instead of looping forever', async () => {
  jest
    .mocked(list)
    .mockResolvedValue({ files: [], nextPageToken: 'same' } as never);
  await expect(readDir('parent')).rejects.toThrow('repeated page token');
});
