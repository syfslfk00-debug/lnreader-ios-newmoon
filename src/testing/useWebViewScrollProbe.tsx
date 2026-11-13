import { useEffect, useRef } from 'react';
import { Text } from 'react-native';
import NativeFile from '@modules/native-file';

/** UIKit pan state + native contentOffset, not DOM touch heuristics. */
export const useWebViewScrollProbe = () => {
  const ref = useRef<Text>(null);
  const enabled = Boolean(NativeFile.E2ESurface);
  useEffect(() => {
    if (!enabled) return;
    const subscription = NativeFile.addListener(
      'onWebViewScrollProbe',
      metrics => {
        ref.current?.setNativeProps({
          accessibilityLabel: JSON.stringify(metrics),
        });
      },
    );
    void NativeFile.startWebViewScrollProbe().catch(error => {
      ref.current?.setNativeProps({
        accessibilityLabel: JSON.stringify({ error: String(error) }),
      });
    });
    return () => {
      subscription.remove();
      NativeFile.stopWebViewScrollProbe();
    };
  }, [enabled]);
  return {
    probe: enabled ? (
      <Text
        ref={ref}
        testID="moon-scroll-probe"
        accessibilityLabel='{"y":0,"release":-1,"coast":0}'
        style={{ position: 'absolute', top: 4, left: 4, fontSize: 1 }}
      >
        .
      </Text>
    ) : null,
  };
};
