module.exports = ({ config }) => {
  const iosClientId = process.env.GOOGLE_IOS_CLIENT_ID || '';
  if (
    iosClientId &&
    !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(iosClientId)
  ) {
    throw new Error('GOOGLE_IOS_CLIENT_ID must be an iOS OAuth client ID');
  }
  return {
    ...config,
    plugins: [
      ...(config.plugins || []),
      ...(iosClientId
        ? [
            [
              '@react-native-google-signin/google-signin',
              {
                iosUrlScheme: iosClientId.split('.').reverse().join('.'),
              },
            ],
          ]
        : []),
    ],
    extra: { ...config.extra, googleIosClientId: iosClientId },
  };
};
