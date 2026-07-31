module Api
  class MemoryController < BaseController
    before_action :require_channel_access!

    def index
      entries = params[:q].present? ?
        Memory::Store.current.search(channel!, params[:q]) :
        channel!.memory_entries.current.by_trust.limit(50)
      render json: entries.map { |e| serialize(e) }
    end

    # Direct write. Distillation proposes a Promotion instead; this path is
    # for a person deliberately recording something the room should know.
    def create
      entry = Memory::Store.current.write(
        channel!, title: params.require(:title), detail: params.require(:detail),
        overview: params[:overview], trust: params[:trust] || "human", author: current_user
      )
      Activity.log(actor: current_user, action: "memory.written", subject: entry)
      render json: serialize(entry), status: :created
    end

    private

    def serialize(e)
      e.slice(:id, :uri, :title, :abstract, :overview, :detail, :trust, :created_at)
    end
  end
end
