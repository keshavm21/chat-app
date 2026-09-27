import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/useAuth';
import api from '../api/axios';
import { getErrorMessage } from '../lib/errors';

export default function Login() {
  const [form, setForm]       = useState({ email: '', password: '' });
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const { login }  = useAuth();
  const navigate   = useNavigate();

  const handleChange = (e) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    if (error) setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/login', form);
      login(data.user);
      navigate('/chat');
    } catch (err) {
      setError(getErrorMessage(err, 'Login failed. Please try again.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0b14] grid-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm fade-in-up">

        {/* Header */}
        <div className="text-center mb-7">
          <Link to="/" className="inline-block mb-5 text-2xl font-bold text-white hover:text-indigo-300 transition-colors">
            Relay
          </Link>
          <h2 className="text-2xl font-bold text-white">Welcome back</h2>
          <p className="text-slate-500 mt-1.5 text-sm">Sign in to continue chatting</p>
        </div>

        {/* Card */}
        <div className="bg-[#111827] rounded-2xl p-6 card-glow">

          {error && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">

            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">
                Email
              </label>
              <input
                type="email"
                name="email"
                value={form.email}
                onChange={handleChange}
                placeholder="you@example.com"
                required
                className="w-full px-4 py-2.5 bg-[#0d1117] border border-[#1f2937] rounded-xl text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40 transition-colors text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1.5">
                Password
              </label>
              <input
                type="password"
                name="password"
                value={form.password}
                onChange={handleChange}
                placeholder="••••••••"
                required
                className="w-full px-4 py-2.5 bg-[#0d1117] border border-[#1f2937] rounded-xl text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/40 transition-colors text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 mt-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] text-sm flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Signing in…
                </>
              ) : 'Sign in'}
            </button>

          </form>
        </div>

        <p className="text-center mt-5 text-slate-500 text-sm">
          New here?{' '}
          <Link to="/signup" className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
            Create an account
          </Link>
        </p>

      </div>
    </div>
  );
}