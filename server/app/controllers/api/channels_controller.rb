module Api
  class ChannelsController < BaseController
    before_action :require_channel_access!, only: %i[show context]

    def index
      render json: Channel.order(:name).map { |c| serialize(c) }
    end

    def create
      channel = Channel.create!(
        slug: params.require(:slug), name: params.require(:name),
        purpose: params[:purpose], visibility: params[:visibility] || "open"
      )
      channel.memberships.create!(user: current_user, role: "owner")
      Activity.log(actor: current_user, action: "channel.created", subject: channel)
      render json: serialize(channel), status: :created
    end

    def show
      channel!.memberships.find_or_create_by!(user: current_user)
      render json: serialize(channel!).merge(
        messages: channel!.messages.includes(:author).order(:created_at).last(200).map { |m| MessageSerializer.call(m) }
      )
    end

    # What the room knows, ready to be injected into an agent session.
    def context
      render json: {
        channel: channel!.slug,
        memory_uri: channel!.memory_uri,
        context: Memory::Store.current.context_for(channel!)
      }
    end

    private

    def serialize(c)
      c.slice(:id, :slug, :name, :purpose, :visibility, :memory_uri)
       .merge(message_count: c.messages.count, memory_count: c.memory_entries.current.count)
    end
  end
end
