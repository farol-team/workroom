module Api
  module V1
    # An agent turn. The client owns the agent process; the server owns the
    # record of what it did — including token counts, which are reporting,
    # never billing: the model credentials stay on the user's machine.
    class RunsController < BaseController
      before_action :require_channel_access!, only: :create

      def create
        agent_kind = params[:agent_kind].presence || "opencode"
        session = AgentSession.live_for(current_user, channel!, agent_kind).first ||
                  AgentSession.create!(user: current_user, channel: channel!,
                                       agent_kind: agent_kind,
                                       external_id: params[:external_id], status: "running",
                                       started_at: Time.current)
        session.update!(status: "running", external_id: params[:external_id].presence || session.external_id)

        run = session.agent_runs.create!(
          trigger_message_id: params[:trigger_message_id], status: "running",
          started_at: Time.current, model: params[:model]
        )
        Broadcast.run(run)
        render json: { id: run.id, agent_session_id: session.id }, status: :created
      end

      def update
        run = find_run
        # Every metric the agent gives us, tokens included (#97). `compact`
        # keeps absent absent — a zero and an unknown are different numbers.
        run.update!(params.permit(:status, :context_used, :context_size, :cost, :cost_currency,
                                  :stop_reason, :input_tokens, :output_tokens,
                                  :cached_read_tokens, :cached_write_tokens,
                                  :thought_tokens, :total_tokens, metrics: {}).to_h.compact)
        run.update!(ended_at: Time.current) if %w[succeeded failed interrupted].include?(run.status)
        run.agent_session.update!(status: "idle") if run.ended_at
        Broadcast.run(run)
        render json: { ok: true }
      end

      def step
        run = find_run
        s = run.run_steps.create!(kind: params.require(:kind), label: params[:label],
                                  payload: params[:payload] || {})
        Broadcast.step(s)
        render json: { ok: true }
      end

      def message
        run = find_run
        m = run.agent_session.channel.messages.create!(
          author: run, body: params.require(:body), parent_id: run.trigger_message_id
        )
        Broadcast.message(m)
        render json: MessageSerializer.call(m), status: :created
      end

      # A revision appends. The client shows the latest; the record keeps them all.
      def plan
        run = find_run
        entries = params.require(:entries).map { |e| e.permit(:content, :priority, :status).to_h }
        step = run.run_steps.create!(kind: "plan", payload: { entries: entries })
        Broadcast.plan(step)
        render json: { ok: true, entries: entries.length }
      end

      private

      def find_run
        AgentRun.joins(:agent_session).where(agent_sessions: { user_id: current_user.id }).find(params[:id])
      end
    end
  end
end
