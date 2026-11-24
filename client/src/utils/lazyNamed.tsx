import React, { Suspense, lazy, type ComponentType } from 'react';

export function lazyNamed<
  TModule extends Record<string, any>,
  TKey extends keyof TModule
>(
  loader: () => Promise<TModule>,
  exportName: TKey
): React.LazyExoticComponent<TModule[TKey] extends ComponentType<any> ? TModule[TKey] : ComponentType<any>> {
  return lazy(async () => {
    const mod = await loader();
    return { default: mod[exportName] };
  }) as React.LazyExoticComponent<
    TModule[TKey] extends ComponentType<any> ? TModule[TKey] : ComponentType<any>
  >;
}

interface LazyBoundaryState {
  hasError: boolean;
}

class LazyErrorBoundary extends React.Component<
  { children: React.ReactNode },
  LazyBoundaryState
> {
  state: LazyBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LazyBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-gray-600 dark:text-neutral-300">
            模块加载失败（可能系统已更新版本）
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition cursor-pointer"
          >
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const LazyViewFallback: React.FC<{ label?: string }> = ({ label }) => (
  <div className="w-full h-full min-h-[240px] flex items-center justify-center">
    <div className="flex flex-col items-center gap-2.5">
      <div className="animate-spin rounded-full h-7 w-7 border-2 border-blue-600 dark:border-blue-400 border-t-transparent" />
      {label ? (
        <span className="text-xs text-gray-500 dark:text-neutral-400">{label}</span>
      ) : null}
    </div>
  </div>
);

export const LazyBoundary: React.FC<{
  children: React.ReactNode;
  fallback?: React.ReactNode;
}> = ({ children, fallback }) => (
  <LazyErrorBoundary>
    <Suspense fallback={fallback ?? <LazyViewFallback />}>{children}</Suspense>
  </LazyErrorBoundary>
);
