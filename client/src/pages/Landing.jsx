import { Link } from 'react-router-dom';

// What Relay does, in a few words each (the README has the long version).
const FEATURES = [
  { title: 'Channels', text: 'Public channels anyone can join, and private ones only invited people can see.' },
  { title: 'Direct messages', text: 'One-to-one conversations with anyone, found by username.' },
  { title: 'Live', text: 'Messages, typing and unread counts update the moment they happen.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-[#0a0b14] grid-bg flex flex-col items-center justify-center px-4 py-12">

      {/* Icon + wordmark */}
      <div className="fade-in-up text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/15 border border-indigo-500/25 mb-5">
          <svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M4 8C4 6.343 5.343 5 7 5H25C26.657 5 28 6.343 28 8V20C28 21.657 26.657 23 25 23H18L12 28V23H7C5.343 23 4 21.657 4 20V8Z"
              fill="#818cf8"
              opacity="0.85"
            />
            <circle cx="11" cy="14" r="1.5" fill="white" opacity="0.65" />
            <circle cx="16" cy="14" r="1.5" fill="white" opacity="0.65" />
            <circle cx="21" cy="14" r="1.5" fill="white" opacity="0.65" />
          </svg>
        </div>

        <h1 className="text-5xl font-bold text-white tracking-tight mb-3">
          Relay
        </h1>
        <p className="text-slate-400 text-lg max-w-sm mx-auto leading-relaxed">
          Real-time chat with channels and direct messages. Fast, simple, no noise.
        </p>
      </div>

      {/* CTAs: the demo first, for a visitor who just wants to look around */}
      <div className="fade-in-up-1 flex flex-col sm:flex-row gap-3">
        <Link
          to="/login?demo"
          className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] text-center"
        >
          Try the demo
        </Link>
        <Link
          to="/signup"
          className="px-8 py-3 bg-white/5 hover:bg-white/10 text-slate-300 font-semibold rounded-xl border border-white/10 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] text-center"
        >
          Create account
        </Link>
        <Link
          to="/login"
          className="px-8 py-3 text-slate-400 hover:text-slate-200 font-semibold rounded-xl transition-colors text-center"
        >
          Sign in
        </Link>
      </div>

      <ul className="fade-in-up-2 mt-12 grid gap-3 sm:grid-cols-3 max-w-3xl w-full">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="rounded-2xl bg-[#111827]/80 border border-[#1f2937] px-5 py-4">
            <h2 className="text-white text-sm font-semibold mb-1" style={{ fontFamily: 'inherit' }}>{feature.title}</h2>
            <p className="text-slate-500 text-sm leading-relaxed">{feature.text}</p>
          </li>
        ))}
      </ul>

      <p className="fade-in-up-2 mt-10 text-slate-600 text-sm">
        Relay · a portfolio project ·{' '}
        <a href="https://github.com/keshavm21/chat-app" className="hover:text-slate-400 underline-offset-2 hover:underline">
          source on GitHub
        </a>
      </p>
    </div>
  );
}
