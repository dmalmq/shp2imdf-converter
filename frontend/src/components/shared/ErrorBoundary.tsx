import { Component, ErrorInfo, ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Keep console logging in Phase 1 for visibility during development.
    console.error("UI error boundary triggered", error, errorInfo);
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="m-8 rounded border border-red-300 bg-red-50 p-4 text-red-700">
          Something went wrong while rendering this screen.
        </div>
      );
    }
    return this.props.children;
  }
}

